/**
 * 72b100cd — PCB 2(II) Pin. 2012, "Statement of Payment by Employer" / "Penyata Bayaran Cukai Oleh
 * Majikan". The PURE model: no database, no rendering, no translation lookup.
 *
 * WHAT THE FORM IS. One statement per EMPLOYEE per year, addressed to the Director General of Inland
 * Revenue, declaring — month by month — the tax the employer deducted from that employee and the receipt
 * LHDN issued for the payment. Two streams, side by side and never added together:
 *
 *   · MTD  (English) / PCB (Bahasa Malaysia) — the ordinary monthly tax deduction. SAME figure, different
 *     official label, which is why the label lives in the label set and not in this model.
 *   · CP38 — an LHDN or court instalment order, a distinct deduction that is not MTD.
 *
 * ⚠️ AN EMPTY BOX AND A ZERO ARE DIFFERENT STATEMENTS TO LHDN, and this model refuses to conflate them.
 * A month's amount is `number | null`: null means "no payroll ran / nothing was deducted and nothing is
 * asserted", and the renderer prints an empty cell. `0.00` would assert that the money does not exist,
 * which is a positive claim about a tax figure nobody made (CLAUDE.md §8). The same holds for a receipt:
 * a month whose tax was paid but whose reference has not been keyed prints an empty reference box beside
 * a real amount, which is exactly what it is.
 *
 * ⚠️ SECTION 3 IS EMPTY ON PURPOSE, AND IT IS NOT AN OMISSION. The official form's third table is
 * "deductions made for the employee's PRECEDING YEAR income in the current year" — arrears for an earlier
 * year, with the MTD attributable to them. This repo can identify such arrears (`back_pay_line`
 * .affected_period against the run's target period) but it CANNOT attribute a share of a month's PCB to
 * one arrears line: PCB is computed on the whole month's pay, and splitting it would be an apportionment
 * nobody performed, printed on a tax document. Measured on production 2026-09-21: zero back-pay lines
 * whose affected period falls in an earlier year, so the section is empty in fact as well as in code.
 * The rows are rendered blank — as the printed form ships them — and `priorYearRows` exists so the day
 * that attribution becomes real there is one place to fill.
 */

/** 1–12, always all twelve, in order — the form prints every month whether or not it has a figure. */
export type Pcb2iiMonth = {
  month: number;
  /** Amount (RM) · MTD/PCB. NULL ⇒ print nothing. See the header on why this is not 0. */
  mtd: number | null;
  /** Amount (RM) · CP38. NULL ⇒ print nothing. */
  cp38: number | null;
  /** Receipt No./Bank Slip No./Transaction No., per stream. NULL ⇒ not keyed yet. */
  mtdReceiptRef: string | null;
  cp38ReceiptRef: string | null;
  /** Receipt Date/Transaction Date, per stream, ISO `YYYY-MM-DD`. NULL ⇒ not keyed yet. */
  mtdPaidOn: string | null;
  cp38PaidOn: string | null;
};

/** The third table. Always empty today — see the header. */
export type Pcb2iiPriorYearRow = {
  incomeType: string;
  month: number;
  year: number;
  mtd: number | null;
  receiptRef: string | null;
  paidOn: string | null;
};

export type Pcb2iiForm = {
  /** "Tax Deduction Made During The Year" — the year the twelve rows belong to. */
  year: number;
  /** `Tarikh` — the explicitly selected statement date. Real ISO calendar day. */
  printedOnIso: string;
  /** LHDN branch the statement is addressed to. Blank until somebody records one. */
  branch: string;
  employeeName: string;
  /** New Identity Card No./Passport No. — the IC when there is one, else the passport. */
  newIcOrPassport: string;
  /** Employee Income Tax No. — `employee_statutory_my.tax_number`. */
  employeeTaxNo: string;
  /** Staff No. — `employment.employee_code`. */
  staffNo: string;
  /** Employer's No. (E) — `company_statutory_my.lhdn_employer_no`. */
  employerNo: string;
  months: Pcb2iiMonth[];
  /** Section 3. Empty today, by the reasoning in this file's header. */
  priorYearRows: Pcb2iiPriorYearRow[];
  /** Name Of Officer / Designation / Telephone No. — the selected company LHDN authorised signatory and authority phone. */
  officerName: string;
  officerDesignation: string;
  officerPhone: string;
  /** Name And Address Of Employer. */
  employerNameAddress: string;
};

/**
 * THE TOTAL ROW, and the one rule that makes it honest: a total of nothing is NOTHING.
 *
 * The printed form boxes a Total only under the two Amount columns. If no month in the year carries a
 * figure for a stream, that stream's total is null and the box prints empty — summing twelve nulls to
 * `0.00` would turn twelve absent statements into one positive claim that no tax was deducted all year.
 * Where any month HAS a figure, the total is the sum of the months that do.
 */
export function pcb2iiTotals(months: readonly Pcb2iiMonth[]): { mtd: number | null; cp38: number | null } {
  const sum = (pick: (m: Pcb2iiMonth) => number | null): number | null => {
    const present = months.map(pick).filter((v): v is number => v != null);
    if (present.length === 0) return null;
    return Math.round(present.reduce((a, b) => a + b, 0) * 100) / 100;
  };
  return { mtd: sum((m) => m.mtd), cp38: sum((m) => m.cp38) };
}

/** Twelve empty months, in order — the skeleton every statement starts from. */
export function emptyPcb2iiMonths(): Pcb2iiMonth[] {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    mtd: null,
    cp38: null,
    mtdReceiptRef: null,
    cp38ReceiptRef: null,
    mtdPaidOn: null,
    cp38PaidOn: null,
  }));
}

/** `2026-08-12` → `12/08/2026`; anything malformed or absent → '' rather than `undefined` on a form. */
export function pcb2iiDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** An amount for a box: a real figure to two decimals, or '' when there is none. Never '0.00' for null. */
export function pcb2iiAmount(v: number | null): string {
  return v == null ? '' : v.toFixed(2);
}

/** Preparation failures have public codes; they never include employee identities or amounts. */
export class Pcb2iiPreparationError extends Error {
  constructor(public readonly code: 'selectedDate' | 'signatory' | 'fit', public readonly field?: string) { super(code); }
}
/** A complete, real ISO calendar day. No current-date fallback and no deduction-year restriction. */
export function validPcb2iiSelectedDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
