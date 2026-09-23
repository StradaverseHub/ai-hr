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

import { formatMoney, formatRate } from './money';
import { payslipDisplayEarnings } from '../core/pay-display-category';
import { absenceDaysLabel, payslipAbsenceLines, type PayslipAbsenceLines } from '../core/payslip-absence-lines';
import { payslipEmployerBorne, type EmployerBorneKey } from '../core/payslip-employer-borne';
import { payslipSkbbkLineShown, payslipSkbbkSubject } from '../core/payslip-skbbk-line';
import { payslipZakatLine } from '../core/payslip-zakat-line';
// 6b134681 / 417d4937 — the ONE derivation of "which named pay items explain this figure, and how is a
// line labelled". Shared with the ESS payslip screen and Transaction View → History so the printed
// document cannot itemise a total differently from the screen it was printed from.
import {
  earningRowShown,
  payItemLinesForBuckets,
  payItemLinesReconcile,
  storedComponentLines,
  storedOvertimeLines,
  type OtLegKind,
  type PayItemRateDetail,
  type StoredComponentLine,
} from '../core/payslip-earning-lines';

const n = (v: unknown) => Number(v ?? 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** One named pay item as the run recorded it. `code` is the operator's pay-code; absent on nothing today,
 *  but optional so a line without one still prints its name.
 *
 *  a96d320c — `detail` and `otLeg` are the RATE AND THE INPUT the run recorded (core/payslip-earning-lines
 *  .ts). Both absent on every payslip written before that shipped, which is what keeps those documents
 *  printing exactly as they do now. The document DERIVES NEITHER: it prints what it is given, or nothing. */
export type PayslipEarningLine = {
  code: string | null;
  name: string;
  amount: number;
  detail?: PayItemRateDetail | null;
  otLeg?: OtLegKind | null;
};

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
  /**
   * The company registration number — CARRIED, AND DELIBERATELY NOT PRINTED (a96d320c rev 3).
   *
   * `drawLetterhead` used to draw it, unlabelled, under the document subtitle. The reporter asked for it
   * off: a bare `201901024512` under a company name identifies nothing, and only 2 of the 5 production
   * companies have one, so it appeared on some payslips and not others. It stays on this type because
   * `buildPayslipPdfData` is the ONE place that resolves it for the document, because the admin
   * Individual Payslip screen still shows it, and because "print it WITH a label" is a live possibility.
   * Do not re-add it to the letterhead without a label beside it.
   */
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
  /**
   * a96d320c rev 2 — DOES THIS PAYSLIP RECORD THAT THE EMPLOYEE IS SUBJECT TO SKBBK?
   *
   * `null` on every payslip written before the kernel started stamping it (core/payroll.ts
   * `skbbkSubject`), which is every payslip that exists today — and `null` is why the row predicate below
   * keeps its amount test as well. See `dedRows` for the whole argument.
   */
  socsoSkbbkSubject?: boolean | null;
  eisEmployee: number;
  pcb: number;
  cp38: number;
  /**
   * 3a092cf0 — THE DOCUMENT HAD NO ZAKAT LINE AT ALL, and until the kernel was fixed that was invisibly
   * consistent: total_deductions excluded the zakat, so a box printing EPF/SOCSO/EIS/PCB/CP38 and the
   * absence lines added up exactly. The kernel now charges zakat, so a document without this row would
   * print a TOTAL DEDUCTIONS larger than the rows above it by the zakat — a payslip that does not add up,
   * which is precisely the complaint this item was raised about. 0 ⇒ no row ⇒ every payslip for an
   * employee with no zakat election prints exactly the document it printed before.
   */
  zakat: number;
  /** 3a092cf0 — does this payslip's STORED total already include the zakat above? Off its own blob. */
  zakatCountedInTotal: boolean;
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
  /** 3a092cf0 — the zakat deduction row. Resolved from `me.payslip.zakat`, the label the screens use. */
  zakat: string;
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
  // ─── a96d320c — the rate-and-input vocabulary. REQUIRED, like every label above, so tsc is what keeps
  // the two PDF routes printing the same document. ───
  /** The bare unit words appended to a quantity, composed exactly as `dayUnit`/`daysUnit` already are —
   *  two static literals, never an ICU plural, because a placeholder called without its argument throws
   *  at render behind a 200 and this file is generated rather than rendered. */
  hourUnit: string;
  hoursUnit: string;
  /**
   * The five legs of the statutory overtime calculation, by the kernel's own stored `kind`.
   *
   * A Record over `OtLegKind` rather than five flat keys: tsc then refuses a route that resolves four of
   * them, and adding a sixth leg to the pack breaks both routes at compile time instead of printing an
   * unlabelled row on somebody's payslip.
   */
  otLegs: Record<OtLegKind, string>;
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
    // a96d320c rev 2 — the payslip's OWN record of the SKBBK election, read like every other figure here:
    // off this slip's snapshot, never off today's `employee_statutory_my` row. Both PDF routes come
    // through this function, so neither can decide the question for itself.
    socsoSkbbkSubject: payslipSkbbkSubject(st),
    eisEmployee: eb.employee.eis,
    pcb: eb.employee.pcb,
    cp38: n(st.cp38),
    // 3a092cf0 — read straight off the payslip's own snapshot, like every other deduction here. NOT
    // employer-borne-adjusted: there is no "Employer bears zakat" control, so `eb.employee` has no zakat
    // leg and the figure the employee paid is the figure the slip stamped.
    zakat: n(st.zakat),
    zakatCountedInTotal: payslipZakatLine(st).countedInTotal,
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
    // a96d320c — AND THE STATUTORY OVERTIME LEGS, when the figure came from attendance rather than from a
    // pay item. The two sources are mutually exclusive by construction: the `ot` bucket is fed by typed
    // pay components, `statutory.otDetail` by `prefillOvertimeFromAttendance` — one run's overtime is one
    // or the other. The component lines WIN when both somehow exist, because they carry the pay item's own
    // name and the statutory legs do not; and `earningsRowsOf`'s reconciliation guard is what actually
    // decides whether either may replace the grouped row, so a wrong guess here degrades to today's
    // document rather than to a wrong one.
    overtimeLines: overtimeLinesOf(componentLines, p.statutory),
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
 * a96d320c — WHICH LINES EXPLAIN THE OVERTIME FIGURE, from whichever of the two places recorded them.
 *
 * `statutory.componentLines` explains an OT figure built out of typed pay items. `statutory.otDetail`
 * explains one the attendance engine monetised under the EA — the case the board item is actually about,
 * and the one that had nothing stored at all. A run produces one or the other, never both; the component
 * lines are preferred when both are present because they carry the pay item's own description, which is
 * strictly more informative than a rule name.
 */
function overtimeLinesOf(lines: StoredComponentLine[], statutory: unknown): PayslipEarningLine[] {
  const fromComponents = payItemLinesForBuckets(lines, ['ot']);
  return fromComponents.length > 0 ? fromComponents : storedOvertimeLines(statutory);
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
/** Height the YTD table needs. a96d320c turned it into a ruled box and the number did not move:
 *  BOX_HEAD_H (20, the header band) + 14 (the column-header row) + 6 × 15 (the rows) = 124, the same
 *  total the loose caption + column header + six rows occupied. `drawYtd` derives `h` from those same
 *  constants rather than repeating the literal, so the two cannot drift. */
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
  // a96d320c — a RATE is not an amount: it keeps up to four decimals so `qty × rate` still produces the
  // amount printed beside it. See `formatRate`.
  const rate = (v: number) => formatRate(v, d.currency ?? null);

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
    const totalTop = top - BOX_HEAD_H - bodyH;
    // a96d320c rev 2 — THE NOTCH THE REPORTER CIRCLED, FOUR TIMES, IN THE SAME PLACE EACH TIME.
    //
    // Both BAND rectangles are FILLED and have no border of their own, and both are the FULL WIDTH of the
    // box at the SAME x. Drawn after the outline — which is what this did — a fill paints over the
    // outline's left and right edges for its own height: a notch out of the border at the top-left and
    // top-right of every box, and a second pair (plus the bottom edge, when no note follows) around the
    // total row. Earnings, Deductions, Employer contributions and Payment information: four boxes, one
    // circle each.
    //
    // FIXED BY ORDERING, not by insetting the bands. An inset would have to be derived from `borderWidth`
    // and would silently stop matching the moment that constant moved; painting the fills first and
    // stroking the outline last cannot drift, and it is the order `drawGrid` and `drawYtd` use.
    //
    // THE NOTCH IS PRE-EXISTING — but "r328 did not touch this function" was WRONG and is corrected
    // here, because the parent asserted it in a plan the reporter read. r328 (a96d320c rev 1) ruled the
    // employee panel and the YTD table, two blocks that had no rules at all, AND it changed this
    // function: the row hairline below went from inset 6pt to edge-to-edge. That is what made the
    // washed-out bottom border on Payment information — one of the four boxes they circled — an r328
    // regression rather than a pre-existing fault. See the rev-2 note on that hairline below.
    // So: the NOTCH (a filled band over the outline) predates r328; the WASHED-OUT BOTTOM BORDER does
    // not. Both are fixed here, and the reporter is owed the distinction in plain words.
    pg.drawRectangle({ x, y: top - BOX_HEAD_H, width: p.w, height: BOX_HEAD_H, color: BAND }); // header band
    if (p.total) pg.drawRectangle({ x, y: totalTop - BOX_TOTAL_H, width: p.w, height: BOX_TOTAL_H, color: BAND });
    pg.drawRectangle({ x, y: top - h, width: p.w, height: h, borderColor: RULE, borderWidth: 0.8 });
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
    p.rows.forEach((r, i) => {
      const color = r.muted ? MUTED : INK;
      // The amount sits on the row's FIRST baseline whatever the label does below it, so a column of
      // figures still reads as a column when one description above it took two lines.
      r.lines.forEach((line, j) => at(pg, line, x + 10, ry - 10.5 - j * LINE_H, 8.5, font, color));
      atR(pg, r.value, x + p.w - 10, ry - 10.5, 8.5, font, color);
      ry -= r.h;
      // a96d320c — EDGE TO EDGE. This rule was inset 6pt either side, so it read as a floating divider
      // between two rows rather than as the line between two cells of one ruled box. The reporter asked
      // for full borders; a box whose own outer border does not meet its row rules is the half-ruled
      // thing they were looking at. Same rule, same colour, same y — it simply reaches the border now.
      //
      // a96d320c rev 2 — …EXCEPT UNDER THE LAST ROW OF A BOX THAT HAS NOTHING BELOW IT, where this y IS
      // the box's bottom border. Payment information is such a box (no total, no note) and it is one of
      // the four the reporter circled: a 0.5pt HAIR drawn on top of the 0.8pt RULE border washed that
      // border out to near-white for its whole length, leaving 0.15pt of colour either side. `drawGrid`
      // and `drawYtd` already say this in as many words — "the LAST row gets no rule under it: that is
      // the outer border" — and `paintBox` was the one painter that did not.
      const isBottomBorder = i === p.rows.length - 1 && !p.total && p.noteLines.length === 0;
      if (!isBottomBorder) pg.drawLine({ start: { x, y: ry }, end: { x: x + p.w, y: ry }, thickness: 0.5, color: HAIR });
    });

    let by = totalTop;
    if (p.total) {
      pg.drawLine({ start: { x, y: by }, end: { x: x + p.w, y: by }, thickness: 0.8, color: RULE });
      at(pg, p.total.label.toUpperCase(), x + 10, by - 14, 8, bold, INK);
      atR(pg, p.total.value, x + p.w - 10, by - 14, 9.5, bold, p.total.color ?? INK);
      by -= BOX_TOTAL_H;
    }
    p.noteLines.forEach((line, i) => at(pg, line, x + 10, by - 10 - i * 9, 7, font, MUTED));
    return h;
  };

  // ─── the rows this payslip prints ───
  const earnRows = earningsRowsOf(d, t, rate);
  // THE FOUR STATUTORY LINES PRINT AT 0.00 AND THAT IS NOT AN OVERSIGHT. The reporter asked for empty
  // lines to go; they wrote the exception themselves ("unless a particular statutory or payslip
  // requirement specifically requires a zero-value item to be displayed") and approved its use here in
  // writing. CLAUDE.md §8: an absent box asserts nothing, `0.00` asserts the money does not exist. "PCB
  // 0.00" tells the employee no tax was taken this month; a payslip that simply does not mention tax
  // tells them nothing, and that is the line they read when they file their own return. Do not "tidy"
  // these four to match the earnings rule — the difference between the two boxes is the point.
  const dedRows: Row[] = [
    { label: t.epf, amount: d.epfEmployee },
    { label: t.socso, amount: d.socsoEmployee },
    // a96d320c rev 2 — SKBBK IS AN ELECTION, SO TEST THE ELECTION. `> 0` was being asked to mean "this
    // employee has no SKBBK", which it cannot: it conflated that with "has SKBBK, contributed 0.00 this
    // run", and on the second of those the zero is the assertion — exactly what the three lines around it
    // are kept for. The predicate is `core/payslip-skbbk-line.ts`, shared with the three payslip screens
    // that carried the same defect, and its docblock carries the whole argument (including why the amount
    // clause can never be dropped: every payslip issued before the stamp answers `null`).
    ...(payslipSkbbkLineShown(d.socsoSkbbkSubject ?? null, d.socsoSkbbk)
      ? [{ label: t.skbbk, amount: d.socsoSkbbk }]
      : []),
    { label: t.eis, amount: d.eisEmployee },
    { label: t.pcb, amount: d.pcb },
    ...(d.cp38 > 0 ? [{ label: t.cp38, amount: d.cp38 }] : []),
    // 3a092cf0 — the zakat line, so the box adds up to the TOTAL DEDUCTIONS it prints. It sits after the
    // tax lines because that is where it sits on both screens and because that is the order it is
    // applied in: the §E.5 offset reduces the PCB above it first, and what is charged here is what
    // survived that. Absent when there is no election, which is every payslip issued before this item.
    // 3a092cf0 — ONLY on a slip whose stored total actually counts it. `d.zakatCountedInTotal` comes
    // from the payslip's own stamp (core/payslip-zakat-line.ts). A pre-3a092cf0 document keeps the
    // shape it has always had: no counted row, and the informational note below still explains the
    // offset — otherwise the drawn rows would sum ABOVE the TOTAL DEDUCTIONS printed underneath them,
    // which is the very defect this item exists to remove, inflicted on history.
    ...(d.zakat > 0 && d.zakatCountedInTotal ? [{ label: t.zakat, amount: d.zakat }] : []),
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
  // a96d320c — THE PAY CODE COMES OFF THE EMPLOYEE'S DOCUMENT (site 1 of 2; the other is in
  // `earningsRowsOf`). `sub` carried `l.code`, so every line printed "Petrol card · A0031". The code is
  // an internal reconciliation key: the operator reconciles by it on the admin screens, which still show
  // it, and the employee has nothing to reconcile it against. The NAME is what the line is.
  //
  // THE `sub` SLOT ITSELF STAYS, and that is the whole care in this change: the deduction box uses the
  // same slot for `absenceDaysLabel` ("2 days" beside an unpaid-leave line), which is employee-readable
  // and is the opposite of what the reporter objected to. Removing the mechanism would have taken that
  // with it.
  const nonPayableRows: Row[] = (d.nonPayableLines ?? []).map((l) => ({
    label: l.name,
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
    // a96d320c rev 3 — THE COMPANY REGISTRATION NUMBER IS OFF THE LETTERHEAD.
    //
    // It was drawn here, under the subtitle, WITH NO LABEL: `company.registrationNo` (core/payroll.ts),
    // so a reader met "201901024512" on its own under the company name with nothing saying what it was.
    // Two of the five production companies carry one, so the same document printed a bare unexplained
    // figure for some employees and not for others — which is how an unidentified number on a payroll
    // document gets read as an amount. The reporter asked for it off and this is that.
    //
    // `d.companyReg` IS STILL CARRIED on PayslipPdfData and still populated by `buildPayslipPdfData`,
    // deliberately: the admin Individual Payslip screen prints it (app/payroll/individual-payslip
    // /page.tsx) off its own read, the builder is the one place that resolves it, and a LABELLED
    // registration line is the obvious next request. What may not survive is the SPACE it reserved —
    // see the height below, which is the half of this change that has no visible cause.
    // "August 2026", not "2026-08" (f35f758a). Resolved by the caller; English on the document because the
    // embedded font is Latin-1 — see PayslipPdfLabels.periodLabel.
    atR(pg, t.periodLabel, A4_W - M, top - 16, 13, bold);
    if (d.payDate) atR(pg, t.paymentDate, A4_W - M, top - 29, 8.5, font, MUTED);
    // a96d320c rev 3 — ONE height, not two. This read `(d.companyReg ? 46 : 34)`: 46 when a registration
    // number was drawn on the third line, 34 when it was not. With the number gone, leaving the ternary
    // would reserve a 12pt line for a string nothing draws — an empty band between the subtitle and the
    // letterhead rule on a payslip from a registered company, and no band on one from a company without a
    // number. The same document in two shapes, for a difference the reader can no longer see. The
    // letterhead is now the SAME HEIGHT whether the payslip carries a registration number or not, and
    // `test/payslip-pdf.test.ts` renders both and compares the rule's y to keep it that way.
    const textH = (nameLines.length - 1) * 18 + 34;
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
    // a96d320c — the identity fields sit in a RULED GRID, not in loose label-over-value pairs. Nothing
    // about which fields are printed changes; `drawGrid` draws the box and the cell rules it always
    // measured for.
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
      // a96d320c — the floating PILL becomes a full-width HEADER BAND over a ruled grid, which is exactly
      // the shape `paintBox` gives Earnings, Deductions and every other section. One visual language for
      // every block on the document was the reporter's point; a heading that only covers its own text
      // width, sitting above unruled rows, was the odd one out. The band keeps PRIMARY + white text, so
      // the accent survives — what changes is that it is the top of a box rather than a label beside one.
      const bandH = 17;
      pg.drawRectangle({ x: rightX, y: top - bandH, width: rightW, height: bandH, color: PRIMARY });
      at(pg, t.employmentInfo.toUpperCase(), rightX + 10, top - 12.5, 7.5, bold, WHITE);
      // TWO columns, not three: a position title ("Senior Business Analyst") does not fit a third of this
      // panel and would print truncated on an official document.
      const gridH = drawGrid(pg, infoCells, rightX, top - bandH, rightW, 2);
      rightH = bandH + gridH;
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
    // a96d320c — cell text is INSET from the rules that now surround it. `CELL_PAD` is subtracted from
    // both sides of the wrap width, so a value still wraps rather than running under the rule beside it
    // (nothing on this document clips — see `wrap`); a long field label simply takes one more line, and
    // the row grows with it exactly as it already did.
    const CELL_PAD = 6;
    const textW = cw - 2 * CELL_PAD;
    const planned = cells.map(([k, v]) => ({
      k: wrap(k.toUpperCase(), font, 6.5, textW),
      v: wrap(v, bold, 8.5, textW),
    }));
    // Measured FIRST, drawn second, for the same reason `planBox` measures before `paintBox` draws: the
    // outer border has to know the height of the thing it encloses before the first row is put down.
    const rowHs: number[] = [];
    for (let r = 0; r * cols < planned.length; r += 1) {
      const rowCells = planned.slice(r * cols, r * cols + cols);
      rowHs.push(Math.max(25, ...rowCells.map((c) => c.k.length * 8 + c.v.length * 10.5 + 6.5)));
    }
    const used = rowHs.reduce((s, h) => s + h, 0);

    // The box, then the column rules, then the row rules — all before the text, so no rule can be drawn
    // over a glyph. The LAST row gets no rule under it: that is the outer border.
    pg.drawRectangle({ x, y: top - used, width: w, height: used, borderColor: RULE, borderWidth: 0.8 });
    for (let i = 1; i < cols; i += 1) {
      pg.drawLine({ start: { x: x + i * cw, y: top }, end: { x: x + i * cw, y: top - used }, thickness: 0.5, color: HAIR });
    }
    let ruleY = top;
    for (let r = 0; r < rowHs.length - 1; r += 1) {
      ruleY -= rowHs[r];
      pg.drawLine({ start: { x, y: ruleY }, end: { x: x + w, y: ruleY }, thickness: 0.5, color: HAIR });
    }

    let drawn = 0;
    for (let r = 0; r * cols < planned.length; r += 1) {
      const rowCells = planned.slice(r * cols, r * cols + cols);
      rowCells.forEach((c, i) => {
        const cx = x + i * cw + CELL_PAD;
        const cy = top - drawn;
        c.k.forEach((line, j) => at(pg, line, cx, cy - 7 - j * 8, 6.5, font, MUTED));
        c.v.forEach((line, j) => at(pg, line, cx, cy - c.k.length * 8 - 10.5 - j * 10.5, 8.5, bold));
      });
      drawn += rowHs[r];
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
    // a96d320c — YEAR TO DATE BECOMES A BOX. It was the last block on the document still drawn as a
    // caption over loose rules, and it is the one an employee reads hardest against the boxes above it.
    // Same three columns, same six rows, same figures, same 15pt row pitch — and the SAME total height:
    // BOX_HEAD_H (20) + the column-header row (14) + 6 × 15 = 124 = YTD_H, which is what the page flow
    // reserves for it. The header band and title are drawn exactly as `paintBox` draws a section head, so
    // this block and the Earnings box beside it are now the same object.
    const h = BOX_HEAD_H + 14 + rows.length * 15;
    // a96d320c rev 2 — BAND FIRST, OUTLINE LAST, the same ordering `paintBox` now uses and for the same
    // reason: this band is a FILLED full-width rectangle with no border of its own, so stroking the
    // outline before it left a notch in the border at the top-left and top-right of the YTD box too.
    // The reporter circled the four `paintBox` boxes, not this one — it shipped in r328 with the defect
    // already in it, and fixing only what was circled would have left one box on the page out of step.
    pg.drawRectangle({ x: M, y: top - BOX_HEAD_H, width: CONTENT_W, height: BOX_HEAD_H, color: BAND });
    pg.drawRectangle({ x: M, y: top - h, width: CONTENT_W, height: h, borderColor: RULE, borderWidth: 0.8 });
    pg.drawLine({
      start: { x: M, y: top - BOX_HEAD_H }, end: { x: c3, y: top - BOX_HEAD_H },
      thickness: 0.8, color: RULE,
    });
    at(pg, t.ytdHeading.toUpperCase(), M + 10, top - 13.5, 7.5, bold, INK);
    let ry = top - BOX_HEAD_H;
    at(pg, t.ytdItem.toUpperCase(), M + 10, ry - 9, 6.5, font, MUTED);
    atR(pg, t.ytdCurrent.toUpperCase(), c2, ry - 9, 6.5, font, MUTED);
    atR(pg, t.ytdToDate.toUpperCase(), c3 - 10, ry - 9, 6.5, font, MUTED);
    ry -= 14;
    pg.drawLine({ start: { x: M, y: ry }, end: { x: c3, y: ry }, thickness: 0.8, color: RULE });
    rows.forEach(([label, cur, tot], i) => {
      const last = i === rows.length - 1;
      const f = last ? bold : font;
      at(pg, label, M + 10, ry - 11, 8.5, f);
      atR(pg, money(cur), c2, ry - 11, 8.5, f);
      atR(pg, money(tot), c3 - 10, ry - 11, 8.5, f);
      ry -= 15;
      // The last row's rule IS the outer border — drawing a hairline on top of it would double it.
      if (!last) pg.drawLine({ start: { x: M, y: ry }, end: { x: c3, y: ry }, thickness: 0.5, color: HAIR });
    });
    return h;
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
 * a96d320c rev 2 — AND AN EARNING LINE WITH NOTHING ON IT IS NOT PRINTED AT ALL.
 *
 * "A payslip that is as short as the month it describes": a person paid only their basic salary got
 * Allowances 0.00, Overtime 0.00 and Bonus 0.00 under it, and the reporter asked for those three to go.
 *
 * THE TEST IS THE STORED FIGURE ON THIS PAYSLIP, and nothing else. `d.allowance` / `d.overtime` /
 * `d.bonus` come off the payslip's own snapshot through `payslipDisplayEarnings`; this function reads no
 * `pay_component` flag, no attendance and no clock, so a month that paid no overtime keeps saying so for
 * ever, whatever is configured later.
 *
 * `!== 0`, NOT `> 0`. A figure that somehow went negative is money the reader must be able to see and
 * question; a line that silently vanishes leaves nothing to question, and would also make the rows stop
 * adding up to the TOTAL EARNINGS printed under them. (docs/audits/0085-delta-keys-sign-inventory.md
 * Class B is this exact failure, found on the statutory side of the same document.)
 *
 * THE BASIC SALARY ROW IS NOT SUBJECT TO THIS, DELIBERATELY. It is the one row that says what the
 * employment pays rather than what a pay item added: on an additional (bonus-only) run "Basic salary
 * 0.00" is the statement that this run did not pay the monthly wage, and without it the Earnings box of
 * such a payslip could hold nothing but its own total. The approved plan names Allowance, Overtime,
 * Bonus and "other pay items"; the wage is none of those.
 *
 * THE FOUR STATUTORY DEDUCTION LINES ARE NOT SUBJECT TO IT EITHER — see `dedRows` above, where EPF,
 * SOCSO, EIS and PCB print at 0.00 on purpose. The reporter put that exception in writing and approved
 * it: on those four the zero IS the assertion (CLAUDE.md §8).
 *
 * 6b134681 extends the SAME rule, unchanged, to Overtime and Bonus. Those two were the earnings figures
 * that still printed as bare category words: a one-off keyed as "B0001 — ANGPOW" is additional
 * remuneration, so it lands in the bonus bucket, and the document said "Bonus RM500.00" — the pay item's
 * own code and description were stored on the payslip and printed nowhere. Each figure reconciles against
 * its OWN total, so bonus itemising while overtime does not (an attendance-derived OT figure has no
 * component line to explain it) is a normal outcome, not a special case.
 */
function earningsRowsOf(d: PayslipPdfData, t: PayslipPdfLabels, rate: (v: number) => string): Row[] {
  const rows: Row[] = [{ label: t.basicSalary, amount: d.basic }];
  /**
   * a96d320c — "10 hours × MYR 36.045", composed from what the RUN recorded and nothing else.
   *
   * The quantity and the rate are read off the line; this function does no arithmetic and derives no
   * figure. Composed from static literals rather than an ICU message for the same reason
   * `absenceDaysLabel` is (see core/payslip-absence-lines.ts): a placeholder called without its argument
   * throws at render, behind a 200, on a document nobody re-renders.
   *
   * The multiplication sign is U+00D7, which IS in Latin-1 — `safe()` passes it through, where the
   * typographic dashes and quotes it folds would not survive.
   */
  const detailSub = (l: PayslipEarningLine): string | null => {
    const det = l.detail;
    if (!det) return null;
    const unit =
      det.unit === 'hours'
        ? det.qty === 1
          ? t.hourUnit
          : t.hoursUnit
        : det.unit === 'days'
          ? det.qty === 1
            ? t.dayUnit
            : t.daysUnit
          : null;
    return `${det.qty}${unit ? ` ${unit}` : ''} × ${rate(det.rate)}`;
  };
  /** Named rows for a figure when they add up to it, otherwise the one grouped row, exactly as before. */
  const push = (lines: PayslipEarningLine[] | undefined, total: number, grouped: string) => {
    const named = lines ?? [];
    if (payItemLinesReconcile(named, total)) {
      // a96d320c — site 2 of 2: the pay code is off the EMPLOYEE's payslip (see `nonPayableRows` for the
      // argument, and for why the `sub` slot itself is kept). `l.code` is still read from the stamp and
      // still reaches the admin surfaces through `payItemLabel`; it is only this document that stops
      // printing "Basic salary · BASIC" at somebody who has no use for the second half.
      //
      // …and the slot is now carrying the thing the reporter asked FOR. A statutory overtime leg takes
      // its label from `otLegs` rather than from a stored name, because it is a rule of the Employment
      // Act rather than a pay item somebody keyed.
      for (const l of named) {
        // a96d320c rev 2 — an item that contributed nothing to this figure is not a row about it. Both
        // producers already drop a zero contribution (`payItemLinesForBuckets`, `storedOvertimeLines`), so
        // this changes no document today; it is here because the rule below now depends on it — dropping a
        // 0.00 line cannot move a sum, so the reconciliation that licensed these rows still holds.
        if (!earningRowShown(l.amount)) continue;
        rows.push({ label: l.otLeg ? t.otLegs[l.otLeg] : l.name, sub: detailSub(l), amount: l.amount });
      }
    } else if (earningRowShown(total)) {
      rows.push({ label: grouped, amount: total });
    }
  };
  push(d.earningLines, d.allowance, t.allowances);
  push(d.overtimeLines, d.overtime, t.overtime);
  push(d.bonusLines, d.bonus, t.bonus);
  // Same rule, written the same way since 3c473773: a Claim box appears when there is a claim.
  if (earningRowShown(d.claim)) rows.push({ label: t.claim, amount: d.claim });
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
