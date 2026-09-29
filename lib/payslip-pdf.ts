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

import { bestFaceFor, embedPayslipFaces, payslipFaceScripts, type PayslipFace } from './payslip-pdf-fonts';
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
   * The company registration number, PRINTED UNDER THE COMPANY NAME WITH ITS LABEL (r360).
   *
   * ─── THE HISTORY MATTERS, because this field has been on and off the document once already ───
   *
   * a96d320c rev 3 took it OFF. `drawLetterhead` drew it under the document subtitle with NO LABEL AT ALL,
   * so the reader met a bare `201901024512` under a company name with nothing saying what it was — and
   * only 2 of the 5 production companies carry one, so the same document printed an unexplained figure for
   * some employees and not for others. That comment ended "do not re-add it to the letterhead without a
   * label beside it", and this is the labelled version the reporter then asked for (1fe55a23): `Reg. no.`
   * comes from `PayslipPdfLabels.companyReg`, resolved from the catalogue key the Organization screen owns.
   *
   * NULL ⇒ NO LINE AT ALL, and no space reserved for one. Not an empty caption, not a dash: a company with
   * no registration number has nothing to disclose, and an absent box asserts nothing while a printed
   * "Reg. no. —" asserts that we looked and found none. The letterhead is exactly the height it is today
   * for such a company (`drawLetterhead`, and the test that renders both and compares the rule's y).
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
  /**
   * The cycle half of the letterhead subtitle — "Payroll payslip · Monthly".
   *
   * r360 — the COMPANY'S OWN Pay Cycle name, resolved by the caller through `payslipCycleLabel`
   * (core/payslip-cycle-label.ts), which falls back to the run-type word ("Regular") for a batch that names
   * no cycle. This module neither reads the cycle nor chooses the fallback: it prints the string it is
   * given, so the screen and the document cannot decide the question differently.
   */
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
  /**
   * r360 — the caption in front of the company registration number on the letterhead ("Reg. no.").
   *
   * REQUIRED, like every label on this type, and for the reason stated above: tsc is what stops one of the
   * two PDF routes printing a line the other one does not. Resolved from `admin.organization.regNo`, the
   * key the Organization screen that owns the field already uses in all six catalogues.
   */
  companyReg: string;
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
   * heading. Deliberately English on the document whatever the reader's locale.
   *
   * 5b2a7f0f — AND THE REASON HAS CHANGED, so the note is corrected rather than left to mislead. It used
   * to be a font limit: Helvetica is Latin-1 and `safe()` folded a Chinese, Thai or Tamil month name to
   * question marks. The faces embedded by `lib/payslip-pdf-fonts.ts` can now draw all four scripts, so
   * nothing stops a localized month name any more. It stays English because localizing it would CHANGE
   * WHAT EVERY EXISTING PAYSLIP SAYS, which is outside this round's scope — `lib/payslip-pdf-strings.ts`
   * carries the same correction on `englishMonthYear` and `englishLongDate`.
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

/**
 * 5b2a7f0f — every string this document could draw, for deciding which font faces to embed.
 *
 * A WALK, not a hand-written list. `PayslipPdfLabels` is 68 fields and `PayslipPdfData` carries nested pay
 * item names, absence lines, employer-borne captions and non-payable lines; a list would go stale the next
 * time a label is added and the failure would be silent — a Chinese payslip with one un-embedded string on
 * it, printing '?' exactly where the new label goes. Every string the renderer draws is either one of these
 * or built out of them plus ASCII digits and separators, so this is the closed set.
 *
 * Typed arrays are skipped: `PayslipPdfData.logo.bytes` is image data, not text, and walking it would cost
 * a megabyte of per-byte work on every payslip with a logo.
 */
function payslipDrawableStrings(...roots: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v);
      return;
    }
    if (v == null || typeof v !== 'object') return;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  for (const r of roots) walk(r);
  return out;
}

// ───────────────────────────────── the renderer ─────────────────────────────────

export async function renderPayslipPdf(d: PayslipPdfData, t: PayslipPdfLabels): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} — ${d.payPeriod}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // FOLD FIRST, THEN STRIP. The punctuation this product deliberately emits sits just outside Latin-1:
  // the bullet the bank-account mask is built from (`••••8901`, core/payroll-view.ts) and the typographic
  // dashes and quotes in the translated strings. Stripping those to '?' printed "????8901" where an
  // account number belongs — a masked number that reads as a rendering fault. Folding them to their
  // Latin-1 equivalents keeps the mask a mask.
  //
  // 5b2a7f0f — THE FOLD STAYS; THE CLAMP BECAME FONT-SPECIFIC. This normalisation is the half of `safe()`
  // that earns its place whatever font draws the text: it is why ms and en never lost a string, and it is
  // why pulling in a 6 MB CJK face for one typographic dash cannot happen. What changed is the line that
  // used to follow it — `[^\x20-\x7E\xA0-\xFF] → '?'` — which is a fact about HELVETICA, not about the
  // document. It now applies only to text actually drawn in a standard font (`safe`), while text drawn in
  // an embedded face is clamped to what THAT face can draw (`safeIn`). A character no available face
  // carries still becomes '?': visible, predictable, and never a throw mid-render.
  const fold = (s: string) =>
    (s ?? '')
      .replace(/[•∙]/g, '·') // bullet / operator dot → middle dot
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-―]/g, '-')
      .replace(/…/g, '...');
  /** The text as the BUILT-IN Helvetica will draw it — the fold, then the WinAnsi clamp, unchanged. */
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  // 5b2a7f0f — THE UNICODE FACES, and none at all when none is needed.
  //
  // `payslipFaceScripts` reads the strings this document will actually draw. An en or ms payslip has no
  // codepoint outside Latin-1 once folded, so this reads no font file, imports no fontkit, embeds nothing,
  // and the document below is byte-for-byte what it was before this change — which is the regression guard
  // in test/payslip-pdf-unicode.test.ts. A zh payslip embeds one CJK face, subsetted to its own glyphs.
  const faces: PayslipFace[] = await embedPayslipFaces(
    doc,
    payslipFaceScripts(payslipDrawableStrings(d, t).map(fold)),
  );

  /**
   * Which font actually draws `s`.
   *
   * PER STRING, not per document. An en-locale payslip for an employee whose name is written in Chinese
   * characters is an ordinary Malaysian payslip: its labels and its figures stay in Helvetica and only the
   * name reaches the CJK face. Resolving once for the whole document would have redrawn every number on
   * that employee's payslip in a different typeface from their colleague's.
   *
   * A font that is ALREADY a face is returned untouched. That is what lets a caller resolve once and pass
   * the answer to both `wrap` (which measures) and `at` (which draws) — a wrapped line of a Tamil string
   * must not be measured in one font and drawn in another, or the column it was fitted to stops holding.
   */
  const faceOf = (s: string, f: PDFFont): PDFFont => {
    if (f !== font && f !== bold) return f;
    const face = bestFaceFor(fold(s), faces);
    return face ? (f === bold ? face.bold : face.regular) : f;
  };
  const charsOf = (f: PDFFont) => faces.find((x) => x.regular === f || x.bold === f)?.chars ?? null;
  /** The text as `f` will draw it: the fold, then a clamp to what `f` actually carries. */
  const safeIn = (s: string, f: PDFFont): string => {
    const chars = charsOf(f);
    if (!chars) return safe(s);
    let out = '';
    for (const ch of fold(s)) {
      const cp = ch.codePointAt(0);
      out += cp != null && chars.has(cp) ? ch : '?';
    }
    return out;
  };
  /** How wide `s` will be once drawn — the face AND the clamp both move the answer. */
  const widthOf = (s: string, f: PDFFont, size: number) => {
    const ff = faceOf(s, f);
    return ff.widthOfTextAtSize(safeIn(s, ff), size);
  };
  /**
   * 5b2a7f0f — THE LARGEST SIZE AT OR BELOW `base` AT WHICH `s` FITS `maxW`.
   *
   * For the two places on this document that put a LABEL and an AMOUNT on ONE baseline with no wrapping
   * between them: a box's total row and a Year-to-date row. Everything else on the page wraps, and this
   * cannot (the total band is a fixed 21pt and a second line would put a rule through it).
   *
   * THE DEFECT THIS FIXES WAS INVISIBLE UNTIL THE FONTS ARRIVED. While every non-Latin label folded to
   * '?', the longest total caption on the document was English. Rendered for real, Vietnamese's
   * "TỔNG CHI PHÍ NGƯỜI SỬ DỤNG LAO ĐỘNG" is half as wide again as the column and printed straight THROUGH
   * "MYR 8,141.55" — two strings overlapping on a payroll document, which is worse than the clipping
   * f35f758a removed, because the reader cannot tell which characters belong to the amount.
   *
   * SHRINK, NOT WRAP AND NOT CLIP: the band height is load-bearing (`BOX_TOTAL_H` aligns the two columns'
   * totals, a96d320c rev 3), and nothing on this document ends in dots. A label that still does not fit at
   * the 5.5pt floor would overlap — no label in any of the six catalogues comes close, and
   * test/payslip-pdf-unicode.test.ts renders all six and checks the floor was never reached.
   */
  const fitSize = (s: string, f: PDFFont, base: number, maxW: number): number => {
    if (maxW <= 0) return base;
    let size = base;
    while (size > 5.5 && widthOf(s, f, size) > maxW) size -= 0.25;
    return size;
  };
  // 5c198931 — the ISO code is a PREFIX via lib/money.ts, so a company paid in SGD stops being told its
  // payroll is in ringgit. An absent currency prints the bare number: unlabelled is honest, "RM" is a claim.
  const money = (v: unknown) => formatMoney(v, d.currency ?? null);
  // a96d320c — a RATE is not an amount: it keeps up to four decimals so `qty × rate` still produces the
  // amount printed beside it. See `formatRate`.
  const rate = (v: number) => formatRate(v, d.currency ?? null);

  const logo = await embedLogo(doc, d.logo);

  // ─── page-scoped drawing primitives ───
  const at = (page: PDFPage, s: string, x: number, y: number, size: number, f: PDFFont = font, color = INK) => {
    const ff = faceOf(s, f);
    page.drawText(safeIn(s, ff), { x, y, size, font: ff, color });
  };
  const atR = (page: PDFPage, s: string, xr: number, y: number, size: number, f: PDFFont = font, color = INK) => {
    const ff = faceOf(s, f);
    const txt = safeIn(s, ff);
    page.drawText(txt, { x: xr - ff.widthOfTextAtSize(txt, size), y, size, font: ff, color });
  };
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
    // 5b2a7f0f — measured in the face that will DRAW it. `faceOf` is idempotent on a face, so a caller
    // that resolved first and passed its answer in gets exactly that font here and at every `at` below.
    const ff = faceOf(s, f);
    const lines: string[] = [];
    /** Emit whole-column slices of an over-long word; returns the remainder that still fits. */
    const chop = (w: string) => {
      let rest = w;
      while (rest.length > 1 && ff.widthOfTextAtSize(rest, size) > maxW) {
        let cut = rest.length;
        while (cut > 1 && ff.widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      return rest;
    };
    let line = '';
    for (const w of safeIn(s, ff).split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${w}` : w;
      if (line && ff.widthOfTextAtSize(trial, size) > maxW) {
        lines.push(line);
        line = chop(w);
      } else if (!line && ff.widthOfTextAtSize(w, size) > maxW) {
        line = chop(w);
      } else line = trial;
    }
    if (line) lines.push(line);
    return lines;
  };

  /** One row of a box, already wrapped and MEASURED — the height it will occupy is known before anything
   *  is drawn, which is what lets the page flow below decide where a block breaks. */
  // 5b2a7f0f — `labelFont` is the face `planRow` MEASURED the lines in; `paintBox` must draw them in the
  //  same one or a wrapped Tamil description stops fitting the column it was wrapped for.
  type BoxRowPlan = { lines: string[]; labelFont: PDFFont; value: string; muted?: boolean; h: number };
  /** A whole box, measured. `paintBox` draws exactly what `planBox` measured. */
  type BoxPlan = {
    w: number;
    title: string;
    dot?: 'earn' | 'deduct';
    rows: BoxRowPlan[];
    total?: { label: string; value: string; color?: ReturnType<typeof rgb> };
    noteLines: string[];
    /** The face `noteLines` were measured in — see `BoxRowPlan.labelFont`. */
    noteFont: PDFFont;
    /**
     * a96d320c rev 3 — THE ONE THING THAT PUTS TWO TOTALS ON ONE BASELINE.
     *
     * Minimum height for the BODY (the rows between the header band and the total band). The rows are
     * unchanged and nothing is inserted between them; the box simply does not close its body above this
     * height, so a shorter column's total band drops to where the taller column's already is.
     *
     * Set by `flowPair`, and ONLY when both sides are painting their FINAL chunk in the same pass —
     * padding a chunk that continues onto the next sheet would open a blank in the middle of a list. A
     * box asked to pad to less than it already needs is unaffected: this is a floor, never a cap, so it
     * can never crop a row.
     */
    padBodyTo?: number;
  };

  const planRow = (r: Row, w: number): BoxRowPlan => {
    const value = r.text ?? money(r.amount);
    const label = r.sub ? `${r.label} · ${r.sub}` : r.label;
    // The label gets whatever the amount leaves, measured per row. The floor keeps a pathologically wide
    // amount from collapsing the label column to nothing and wrapping it one letter per line.
    const labelW = Math.max(60, w - 28 - widthOf(value, font, 8.5));
    const labelFont = faceOf(label, font);
    const lines = wrap(label, labelFont, 8.5, labelW);
    return { lines, labelFont, value, muted: r.muted, h: Math.max(ROW_H, 4.5 + lines.length * LINE_H) };
  };

  const noteHeightOf = (noteLines: string[]) => (noteLines.length > 0 ? noteLines.length * 9 + 7 : 0);
  /** What the rows alone need. */
  const rowsHeight = (rows: BoxRowPlan[]) => rows.reduce((s, r) => s + r.h, 0);
  /** What the rows OCCUPY once `padBodyTo` has had its say (a96d320c rev 3). A floor, never a cap. */
  const bodyHeight = (p: BoxPlan) => Math.max(rowsHeight(p.rows), p.padBodyTo ?? 0);
  /** Everything under the body: the total band and the note. `chunkFor` and `flowPair` both need it. */
  const tailHeight = (p: BoxPlan) => (p.total ? BOX_TOTAL_H : 0) + noteHeightOf(p.noteLines);
  const boxHeight = (p: BoxPlan) => BOX_HEAD_H + bodyHeight(p) + tailHeight(p);

  const planBox = (o: {
    w: number; title: string; rows: Row[];
    dot?: 'earn' | 'deduct'; total?: { label: string; value: string; color?: ReturnType<typeof rgb> };
    note?: string;
  }): BoxPlan => {
    const noteFont = faceOf(o.note ?? '', font);
    return {
      w: o.w,
      title: o.title,
      dot: o.dot,
      total: o.total,
      rows: o.rows.map((r) => planRow(r, o.w)),
      noteFont,
      noteLines: o.note ? wrap(o.note, noteFont, 7, o.w - 20) : [],
    };
  };

  /**
   * One bordered block: a header band, a body of rows and an optional total row. The body is sized to WHAT
   * IT HOLDS. It used to be padded to a fixed row count (MIN_BOX_ROWS / MAX_BOX_ROWS) so Earnings and
   * Deductions lined up as a pair, which is what left half of the earnings box empty while a long name
   * beside it ran out of room. Earnings and Deductions are a pair again (f35f758a rev 2), but they are
   * aligned by `flowPair` drawing both at the same y — never by padding a box past its own contents.
   */
  const paintBox = (pg: PDFPage, x: number, top: number, p: BoxPlan): number => {
    const rowsH = rowsHeight(p.rows);
    const bodyH = bodyHeight(p);
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
    // stroking the outline last cannot drift, and it is the order `drawYtd` uses. (`drawGrid` used it
    // too, until a96d320c rev 3 de-boxed the employee panel and replaced it with `drawFieldColumns`,
    // which draws no rules at all — see that function for why that is the stronger form of this rule.)
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
      r.lines.forEach((line, j) => at(pg, line, x + 10, ry - 10.5 - j * LINE_H, 8.5, r.labelFont, color));
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
      // border out to near-white for its whole length, leaving 0.15pt of colour either side. `drawYtd`
      // already says this in as many words — "the LAST row gets no rule under it: that is the outer
      // border" — and `paintBox` was the one painter that did not. (`drawGrid` said it too; it is gone,
      // replaced by the rule-free `drawFieldColumns` in a96d320c rev 3.)
      const isLastRow = i === p.rows.length - 1;
      const isBottomBorder = isLastRow && !p.total && p.noteLines.length === 0;
      // a96d320c rev 3 — …AND NO RULE UNDER THE LAST ROW OF A PADDED BODY EITHER. `padBodyTo` drops the
      // total band below where the rows end; the hairline that closes the last row would then be stranded
      // in the middle of that blank, a second horizontal line a few points above the total's own 0.8pt
      // rule with nothing between them. Same family of fault as the two above: a rule drawn where the
      // thing it was closing is no longer.
      const isPadded = isLastRow && bodyH > rowsH;
      if (!isBottomBorder && !isPadded) {
        pg.drawLine({ start: { x, y: ry }, end: { x: x + p.w, y: ry }, thickness: 0.5, color: HAIR });
      }
    });

    let by = totalTop;
    if (p.total) {
      pg.drawLine({ start: { x, y: by }, end: { x: x + p.w, y: by }, thickness: 0.8, color: RULE });
      const totalLabel = p.total.label.toUpperCase();
      const totalSize = fitSize(totalLabel, bold, 8, p.w - 26 - widthOf(p.total.value, bold, 9.5));
      at(pg, totalLabel, x + 10, by - 14, totalSize, bold, INK);
      atR(pg, p.total.value, x + p.w - 10, by - 14, 9.5, bold, p.total.color ?? INK);
      by -= BOX_TOTAL_H;
    }
    p.noteLines.forEach((line, i) => at(pg, line, x + 10, by - 10 - i * 9, 7, p.noteFont, MUTED));
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
    const nameFont = faceOf(d.company, bold);
    const nameLines = wrap(d.company, nameFont, 12, CONTENT_W - 200);
    nameLines.forEach((line, i) => at(page, line, M, y - 12 - i * 13, 12, nameFont));
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
   * the total and the note. Measurement only; nothing is drawn.
   *
   * a96d320c rev 3 — `flowPair` is now its only caller. There used to be a one-column `flowBox` beside it,
   * breaking through this same function so that a one-column break and a two-column break could not
   * disagree; its only user was the full-width Non-payable box below NET PAY, and that box is now the
   * right-hand side of the Employer contributions pair ("Other"). An uncalled flow painter is dead
   * machinery, so it went with the block that used it — `git log` has it if a full-width flowing box is
   * ever wanted again. This function did NOT change: the break decision is still made in exactly one place.
   */
  const chunkFor = (plan: BoxPlan, rows: BoxRowPlan[], avail: number) => {
    const tailH = tailHeight(plan);
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
      /**
       * a96d320c rev 3 — ONE BASELINE FOR THE TWO TOTALS.
       *
       * They were never aligned. Both sides start at the same `y` and `used = Math.max(...)` advances the
       * flow past the taller one, so the TOPS line up and the downward step is shared — but each side is
       * painted by its own `paintBox` with its own `plan.total`, and a total sits at the foot of its OWN
       * content. Five earnings rows beside two deduction rows put TOTAL EARNINGS three rows above TOTAL
       * DEDUCTIONS. The two were only ever level by coincidence, when the columns happened to hold the
       * same number of rows; the reporter is reading a payslip where they do not.
       *
       * The fix is a FLOOR ON THE BODY, not an inserted row and not a taller row: the shorter side's body
       * is held open to the taller side's, so its total band lands where the other one's already is. No
       * row moves, no row is added, and no figure is touched.
       *
       * ⚠️ FINAL CHUNKS ONLY, AND ONLY WHEN BOTH SIDES ARE FINAL IN THE SAME PASS. `total` is handed to
       * `paintBox` on `c.final`; a chunk that continues onto the next sheet has no total to align, and
       * padding it would open a blank band in the middle of a list that carries on overleaf. A side that
       * finished on an EARLIER sheet answers `null` here, and `every` then refuses the padding — its
       * total is on a page this one cannot line up with. The two-page case is exercised explicitly in
       * `test/payslip-pdf.test.ts`; it is where a padding that only looked at `c.final` per side breaks.
       */
      const allFinal = chunks.every((c) => c != null && c.final);
      let padTo = 0;
      if (allFinal) {
        const bodies = chunks.map((c, i) => rowsHeight(sides[i].rows.slice(0, c!.take)));
        const tallest = Math.max(...bodies);
        // ⚠️ ONLY IF BOTH PADDED BOXES STILL CLEAR THE FOOTER. `chunkFor` passed each side on its own
        // height; padding makes the shorter one taller, and when its tail is the heavier of the two (the
        // Earnings note beside a Deductions box with none) the padded box can exceed what was measured.
        // Alignment is a courtesy to the reader; running a box through the footer is a defect. So when it
        // will not fit, the two totals simply stay where they were.
        const fits = sides.every((s) => BOX_HEAD_H + tallest + tailHeight(s.plan) <= avail);
        if (fits) padTo = tallest;
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
            // `padTo` is 0 unless EVERY side is final, so a continued chunk can never be padded; the
            // `c.final` guard repeats that at the point of use rather than trusting it from 30 lines up.
            padBodyTo: c.final ? padTo : 0,
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

  // ─── Employer contributions beside OTHER — or, when there is no Other, beside Payment information ───
  //
  // a96d320c rev 3 — THE SECOND BAND. `Other` is the box that used to be drawn FULL WIDTH BELOW NET PAY
  // (f35f758a, "Non-payable items"): the items this run calculated and did not pay. Below the net figure
  // is the worst place on the document for it — the employee has already found the number they came for,
  // and a full-width box of money they did NOT receive, after it, reads like a second pay total. Beside
  // Employer contributions it reads as what it is: the other half of "what this month cost that is not in
  // your net pay". The reporter asked for it as a COLUMN and this is that column.
  //
  // WHY NOT FOUR ACROSS. Their sketch put Earnings, Deductions, Employer contributions and Other side by
  // side in one row. On A4 that is ~32mm a column, and "Construction Project Management Allowance" wraps
  // to four lines in it — the clipping/cramping fault r179 (f35f758a) was raised to fix. Two across, in
  // two bands, keeps every column at the width that fix bought.
  //
  // PAYMENT INFORMATION MOVES DOWN, and only when Other is present: it is three short text fields and the
  // band below is a better home for them than a third column that does not exist. With no Other — every
  // payslip that exists today — this is byte for byte the pair it has always been.
  const empSpec = {
    x: M, w: COL_W, title: t.employerContributions, continuedTitle: t.employerContributions,
    rows: employerRows,
    total: { label: t.totalEmployerCost, value: money(d.employerCost) },
    note: t.employerContributionsNote,
  } as const;
  // Payment information is printed only when there is something to print. A row of empty labels tells the
  // employee nothing and reads as a broken document; a missing block reads as "not recorded" — the truth.
  const payPlan = payRows.length > 0
    ? planBox({ w: COL_W, title: t.paymentInformation, rows: payRows })
    : null;

  if (nonPayableRows.length > 0) {
    // `flowPair`, not the measure-once pair: a company that starts declaring benefits in kind can declare
    // a lot of them, and the full-width `flowBox` this replaces could already continue across sheets. The
    // list must keep that. Employer contributions is four fixed rows and will never be the side that
    // breaks. `flowPair` also lands TOTAL EMPLOYER COST and the Other total on one baseline, for the same
    // reason and by the same mechanism as Total earnings and Total deductions above.
    flowPair([
      empSpec,
      {
        x: COL2_X, w: COL_W, title: t.nonPayable, continuedTitle: t.nonPayable, rows: nonPayableRows,
        total: { label: t.nonPayableTotal, value: money(nonPayableTotal) },
        note: t.nonPayableNote,
      },
    ]);
    if (payPlan) {
      // Its own band, at COL_W on the left — NOT widened to the full page. Three short text fields
      // stretched across 515pt would put "Maybank" alone in the middle of a line; the box is the size of
      // its contents, which is the rule every other block on this document already follows.
      ensure(boxHeight(payPlan));
      y -= paintBox(page, M, y, payPlan) + GAP;
    }
  } else {
    // Both are SHORT and fixed (four statutory rows; three payment fields), so the simple measure-once
    // pair is still right for them — neither can grow to the length that made Earnings need a continuing
    // flow. Pairing them is also what buys the space for NET PAY to take the full width below. NO
    // PADDING HERE, deliberately: Payment information has no total to align to, so `flowPair` would only
    // open whitespace above TOTAL EMPLOYER COST and change a document that nothing asked to change.
    const empPlan = planBox({
      w: empSpec.w, title: empSpec.title, rows: empSpec.rows, total: empSpec.total, note: empSpec.note,
    });
    const pairH = Math.max(boxHeight(empPlan), payPlan ? boxHeight(payPlan) : 0);
    ensure(pairH);
    paintBox(page, M, y, empPlan);
    if (payPlan) paintBox(page, COL2_X, y, payPlan);
    y -= pairH + GAP;
  }

  // ─── NET PAY, FULL WIDTH ───
  // The one figure the employee looks for first, and now the only thing on its line — which is both what
  // the reporter asked for and what pays for itself: half a row of white space either side of a number is
  // worth less than the ~19pt the pair above just saved.
  const netH = 46;
  ensure(netH);
  page.drawRectangle({ x: M, y: y - netH, width: CONTENT_W, height: netH, color: PRIMARY });
  const netLabel = t.netPay.toUpperCase();
  at(page, netLabel, M + 14, y - 28, fitSize(netLabel, bold, 9.5, CONTENT_W - 28 - widthOf(money(d.net), bold, 15) - 12), bold, WHITE);
  atR(page, money(d.net), A4_W - M - 14, y - 30, 15, bold, WHITE);
  y -= netH + GAP;

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
    const nameFont = faceOf(d.company, bold);
    const nameLines = wrap(d.company, nameFont, 16, A4_W - M - textX - 150);
    nameLines.forEach((line, i) => at(pg, line, textX, top - 16 - i * 18, 16, nameFont));
    const below = top - 16 - (nameLines.length - 1) * 18;
    // ─── r360 — THE REGISTRATION NUMBER IS BACK ON THE LETTERHEAD, THIS TIME WITH ITS NAME ───
    //
    // The reporter asked for it "directly below the company name, labelled Reg. no.", so it sits between
    // the legal name and the document subtitle rather than under the subtitle where a96d320c rev 3 found it
    // unlabelled and took it off. That order is also the order the Individual Payslip SCREEN's letterhead
    // uses (name → registration → period), so the document and the screen read the same way down the page.
    //
    // LABEL, COLON, VALUE, drawn as ONE string: `Reg. no.: 201901024512`, which is the line the approved
    // mockup (docs/mockups/1fe55a23-payslip-header.html) shows the reporter, down to the colon. The
    // separator is a literal beside the catalogue label, exactly as `${t.employeeCode}: …` already is in
    // `drawEmployeePanel` — a second message key for a colon is a translation to keep in step for nothing.
    // One string also means `at` resolves ONE face for the whole line, which is what keeps a Tamil or Thai
    // caption and a Latin-digit number from being measured in one font and drawn in another.
    //
    // ABSENT ⇒ NOTHING DRAWN AND NOTHING RESERVED (see `textH` below). The fallback the plan promised: a
    // company with no registration number gets the letterhead it gets today, not an empty band. The mockup
    // spells that out too — "not 'Reg. no.: —' and not an empty label".
    const regLine = d.companyReg ? `${t.companyReg}: ${d.companyReg}` : null;
    if (regLine) at(pg, regLine, textX, below - 12, 8.5, font, MUTED);
    const sub = [t.documentSubtitle, d.cycleLabel].filter(Boolean).join(' · ');
    at(pg, sub, textX, below - (regLine ? 25 : 13), 9, font, MUTED);
    // "August 2026", not "2026-08" (f35f758a). Resolved by the caller; English on the document by choice
    // now that the font no longer forces it — see PayslipPdfLabels.periodLabel.
    atR(pg, t.periodLabel, A4_W - M, top - 16, 13, bold);
    if (d.payDate) atR(pg, t.paymentDate, A4_W - M, top - 29, 8.5, font, MUTED);
    // r360 — TWO heights again, and THIS time the taller one has a visible cause.
    //
    // a96d320c rev 3 collapsed this to a single 34, and its note is worth keeping rather than deleting: it
    // read `(d.companyReg ? 46 : 34)` while nothing drew the number, so a registered company's payslip
    // carried a 12pt hole where the missing line had been and an unregistered company's did not — the same
    // document in two shapes for a difference the reader could not see. The ternary is only honest when
    // something is drawn in the space it reserves, which is now the case: 46 when the `Reg. no.` line is
    // printed, and 34 — byte-for-byte today's letterhead — when there is nothing to print.
    //
    // `test/payslip-pdf.test.ts` renders both and asserts the difference is exactly the one line, so a
    // future change cannot reserve the band again without drawing in it.
    const textH = (nameLines.length - 1) * 18 + (regLine ? 46 : 34);
    const h = Math.max(logo ? 58 : 0, textH);
    pg.drawLine({ start: { x: M, y: top - h }, end: { x: A4_W - M, y: top - h }, thickness: 1.6, color: RULE });
    return top - h - GAP;
  }

  function drawEmployeePanel(pg: PDFPage, top: number): number {
    const leftW = 218;
    const rightX = M + leftW + GAP;
    const rightW = CONTENT_W - leftW - GAP;

    // The employee's own name was clipped by the same `fit()` the pay items were. It wraps now.
    const nameFont = faceOf(d.employee, bold);
    const nameLines = wrap(d.employee, nameFont, 14, leftW);
    nameLines.forEach((line, i) => at(pg, line, M, top - 14 - i * 16, 14, nameFont));
    const nameH = 27 + (nameLines.length - 1) * 16;
    if (d.employeeCode) at(pg, `${t.employeeCode}: ${d.employeeCode}`, M, top - nameH, 9, font, MUTED);
    const headH = nameH + 7;

    const idCells: [string, string][] = [
      ...(d.identityNumber ? ([[d.identityIsPassport ? t.passport : t.ic, d.identityNumber]] as [string, string][]) : []),
      ...(d.taxNumber ? ([[t.taxNumber, d.taxNumber]] as [string, string][]) : []),
      ...(d.epfNumber ? ([[t.epfNumber, d.epfNumber]] as [string, string][]) : []),
      ...(d.socsoNumber ? ([[t.socsoNumber, d.socsoNumber]] as [string, string][]) : []),
    ];
    // a96d320c rev 3 — THE RULED GRID IS WITHDRAWN AND THIS COMMENT IS ITS RECORD, so it does not come
    // back. It read: "the identity fields sit in a RULED GRID, not in loose label-over-value pairs."
    // That was OUR change (rev 1 / r328), not a request, and the reporter contested it twice and has now
    // approved its reversal in their own words — "remove the unnecessary bordered-line design", "maintain
    // clear alignment between the field labels and values", "avoid excessive borders and visual
    // separation". The fields are back to loose label-over-value pairs, aligned on a shared column grid.
    // DO NOT RE-RULE THIS PANEL: it was tried, it shipped, it was read by the person the document is
    // for, and it was rejected. See `drawFieldColumns` for the defect it also carried.
    const leftH = headH + drawFieldColumns(pg, idCells, M, top - headH, leftW, 2);

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
      // a96d320c rev 3 — THE EMPLOYMENT-INFO HALF IS DE-BOXED TOO, AND THAT IS A DECISION, not a spill.
      //
      // The reporter named the EMPLOYEE block. They also asked, generally, to "avoid excessive borders
      // and visual separation". Three things decided it for the whole panel rather than half of it:
      //   1. THE VOID IS HERE TOO. `drawGrid`'s odd-cell case (see `drawFieldColumns`) is a property of
      //      the grid, not of the identity fields: an employment panel printing department + position +
      //      grade is three cells in a two-column grid and encloses a fourth that is never written into.
      //      Keeping the box here would have meant fixing the void twice, or in a shared function that
      //      one caller no longer uses.
      //   2. TWO HALVES OF ONE PANEL IN TWO VISUAL LANGUAGES is exactly what rev 1's own comment gave as
      //      the reason for boxing this half ("one visual language for every block"). De-boxing the left
      //      and leaving the right ruled would re-create that fault with the sides swapped.
      //   3. THE MONEY IS WHAT THE RULES ARE FOR. Earnings, Deductions, Employer contributions, Other,
      //      Payment information and Year to date are all still ruled boxes and none of them is touched.
      //      What changes is that the identity panel stops competing with them: reference data reads
      //      light, figures read ruled, and the panel is still closed off by the single 0.8pt rule below.
      //
      // The HEADING SURVIVES, as ink rather than as a filled band: same text, same size, same position,
      // same PRIMARY accent — a full-width solid rectangle over a list with no border is the "visual
      // separation" that was objected to, and 7.5pt bold PRIMARY names the column without drawing one.
      // The 17pt it occupies is unchanged, so the flow below this panel does not move.
      const headingH = 17;
      at(pg, t.employmentInfo.toUpperCase(), rightX, top - 12.5, 7.5, bold, PRIMARY);
      // TWO columns, not three: a position title ("Senior Business Analyst") does not fit a third of this
      // panel and would print truncated on an official document.
      const gridH = drawFieldColumns(pg, infoCells, rightX, top - headingH, rightW, 2);
      rightH = headingH + gridH;
    }

    const h = Math.max(leftH, rightH, 40);
    pg.drawLine({ start: { x: M, y: top - h - 8 }, end: { x: A4_W - M, y: top - h - 8 }, thickness: 0.8, color: RULE });
    return top - h - 8 - GAP;
  }

  /**
   * The identity / employment fields as LABEL-OVER-VALUE PAIRS on a shared column grid. No box, no column
   * rule, no row rule. Returns the height consumed, so the caller can align the panel beside it.
   *
   * ─── a96d320c rev 3 — THIS REPLACES `drawGrid`, AND WHY MATTERS MORE THAN WHAT ───
   *
   * `drawGrid` ruled this panel: an outer rectangle, a column rule, a hairline between rows. It was OUR
   * idea (rev 1 / r328), the reporter contested it, and it is now withdrawn on their approval. Their
   * words: "remove the unnecessary bordered-line design", "maintain clear alignment between the field
   * labels and values", "avoid excessive borders and visual separation". THE GRID MUST NOT COME BACK.
   * It is recorded here rather than deleted so the next reader knows it was tried, shipped, read by the
   * person the document is for, and rejected.
   *
   * IT ALSO CARRIED A DEFECT NO STYLING COULD REACH — an EMPTY RULED CELL, on 46 of 84 production
   * employments. Not a missing-field case: `idCells` already spreads to nothing for an absent number, so
   * a payslip with three identity numbers passes three cells. The fault was the DRAW ORDER the grid
   * needed in order to keep rules off glyphs: the outer rectangle was stroked at FULL WIDTH and the
   * column rule from `top` to `top - used` at FULL HEIGHT, both before any text, and only then were the
   * cells filled left to right. An ODD `cells.length` therefore enclosed a cell that was never written
   * into — a ruled, labelled-looking, permanently blank box on an official document. By identity-cell
   * count production reads 0→9, 1→29, 2→2, 3→17, 4→27: the 29 one-number and 17 three-number employments
   * are the 46.
   *
   * THE FIX IS STRUCTURAL, NOT COSMETIC. Suppressing the last column-rule segment when the count is odd
   * (the shape r328's lesson prescribes — suppress a segment, never paint another rectangle over one)
   * would close the void and leave the box the reporter asked to remove. Loose pairs cannot produce a
   * void at ANY cell count, because a row with one field draws one field and nothing else: there is no
   * enclosure to be empty. `test/payslip-pdf.test.ts` renders 0..6 cells and asserts no ruled rectangle
   * appears in this panel at any of them.
   *
   * THE r328 DISCIPLINE IS PRESERVED, absolutely rather than by ordering: `paintBox`, `drawGrid` and
   * `drawYtd` each had to paint fills and rules in a careful sequence "so no rule can be drawn over a
   * glyph", and every regression in this file has been a break in one of those sequences. This function
   * draws NO rules and NO fills, so the property holds unconditionally and cannot be broken by a future
   * edit reordering anything. Anyone adding a rule here inherits the whole problem again.
   *
   * Both halves WRAP (f35f758a). This panel is where "Construction Project Managem…" was printed: a job
   * title, a department name or a long field label got one 25pt row and whatever did not fit was cut.
   * Rows are as tall as their tallest cell, and nothing on this document clips.
   */
  function drawFieldColumns(
    pg: PDFPage, cells: [string, string][], x: number, top: number, w: number, cols: number,
  ): number {
    if (cells.length === 0) return 0;
    const cw = w / cols;
    // a96d320c rev 3 — the label and its value share ONE x, the column's own left edge, and the left
    // column's x is the page margin: the fields line up with the employee's name above them and with the
    // Earnings box below them. `drawGrid` inset its text by CELL_PAD to hold it off the rules beside it;
    // with the rules gone the inset would only push the panel out of alignment with the rest of the page.
    // GUTTER is taken off the WRAP WIDTH instead, so a long value still stops short of the next column
    // rather than running into it.
    const GUTTER = 12;
    const textW = cw - GUTTER;
    const planned = cells.map(([k, v]) => {
      const kf = faceOf(k.toUpperCase(), font);
      const vf = faceOf(v, bold);
      return { kf, vf, k: wrap(k.toUpperCase(), kf, 6.5, textW), v: wrap(v, vf, 8.5, textW) };
    });
    // Measured first, drawn second — the caller needs the height to align the half beside this one, and
    // a row is as tall as the tallest pair in it so a wrapped job title pushes its whole row down.
    const rowHs: number[] = [];
    for (let r = 0; r * cols < planned.length; r += 1) {
      const rowCells = planned.slice(r * cols, r * cols + cols);
      rowHs.push(Math.max(25, ...rowCells.map((c) => c.k.length * 8 + c.v.length * 10.5 + 6.5)));
    }
    const used = rowHs.reduce((s, h) => s + h, 0);

    let drawn = 0;
    for (let r = 0; r * cols < planned.length; r += 1) {
      const rowCells = planned.slice(r * cols, r * cols + cols);
      rowCells.forEach((c, i) => {
        const cx = x + i * cw;
        const cy = top - drawn;
        c.k.forEach((line, j) => at(pg, line, cx, cy - 7 - j * 8, 6.5, c.kf, MUTED));
        c.v.forEach((line, j) => at(pg, line, cx, cy - c.k.length * 8 - 10.5 - j * 10.5, 8.5, c.vf));
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
      // Same one-baseline problem as a box total, same answer — the YTD label shares its line with two
      // amounts and cannot wrap without breaking the 15pt row pitch this table's height is derived from.
      at(pg, label, M + 10, ry - 11, fitSize(label, f, 8.5, c2 - (M + 10) - widthOf(money(cur), f, 8.5) - 8), f);
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
    const w = widthOf(t.generatedNote, font, 7.5);
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
