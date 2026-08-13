/**
 * 5c198931 — every localized string the payslip document needs, resolved ONCE.
 *
 * WHY THIS MODULE EXISTS. Two routes print the payslip: the employee's own
 * (`app/me/payslip/[payslipId]/pdf`) and the admin review copy
 * (`app/payroll/individual-payslip/[payslipId]/pdf`). Each used to assemble its own 25-line label object
 * by hand, and the redesign takes that to forty-odd. Two hand-maintained copies of the same object is how
 * one of them quietly loses a block and the employee's payslip stops being the document the reviewer
 * approved — which is the exact failure this board item was raised about. So the object is built here and
 * tsc keeps the two routes identical by construction.
 *
 * THREE NAMESPACES, deliberately. `me.payslip` owns the payslip vocabulary both surfaces already shared;
 * `payroll.individualPayslip` owns the employment/identity/YTD field names the screen already had (adding
 * a second copy of "Department" under `me.` would be a translation to keep in step for nothing); and
 * `payroll.transactions` owns the payroll-cycle names. Namespaces are not a permission boundary — the
 * admin route has resolved `me.payslip` since 169e3c24 — so this is deduplication, not scope-widening.
 */
import { getTranslations } from 'next-intl/server';

import type { PayslipPdfLabels } from './payslip-pdf';
import type { EmployerBorneKey } from '../core/payslip-employer-borne';

/**
 * f35f758a — "August 2026", not "2026-08".
 *
 * The stored pay period is a TEXT column in `YYYY-MM`, and the document printed it raw. This is the idiom
 * four screens in this repo already use for a month name (statutory-forms, the roster, scheduled actions,
 * the EA report): `Intl.DateTimeFormat`, month long, timeZone UTC — so no month can shift by one in a
 * negative-offset render — over `Date.UTC(y, m - 1, 1)`. No new message keys: twelve month names per
 * locale is a translation set to keep in step for something the platform already knows.
 *
 * PINNED TO ENGLISH, deliberately and only here. The document embeds Helvetica, which is WinAnsi
 * (Latin-1), and `safe()` in the renderer folds anything outside it to '?'. A Chinese, Thai or Tamil month
 * name would print as question marks on a payslip. The SCREENS format the same period with the reader's
 * own locale; the file cannot until a Unicode font is embedded (the deferred half of ADR-0036).
 */
function englishMonthYear(payPeriod: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m) return payPeriod ?? ''; // not a period we recognise ⇒ print what was stored, never a guess
  const month = Number(m[2]);
  if (month < 1 || month > 12) return payPeriod;
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), month - 1, 1)),
  );
}

/**
 * 3c88d593 — the same month name, with the SEGMENT the slip actually covers appended when the month was
 * split by a mid-month entity transfer. "August 2026 (1 Aug - 10 Aug)".
 *
 * WHY THE DOCUMENT AND NOT ONLY THE SCREEN. An employee who transfers mid-month receives TWO payslips for
 * one month, from two different employers. A document headed "August 2026" on both is not a record of
 * anything — the reader cannot tell which ten days it paid, and neither can an auditor five years later.
 *
 * ENGLISH, and short-form dates, for the same reason the month name is English: Helvetica is Latin-1 and
 * `safe()` in the renderer folds anything outside it to '?'. The en dash is U+2013 (Latin-1 does not carry
 * it) so a plain hyphen is used — a payslip with a '?' in its period line would be worse than plain.
 *
 * No segment ⇒ this returns exactly `englishMonthYear`, so every payslip that is not split prints the
 * period line it printed before this item existed.
 */
function englishPeriodLabel(payPeriod: string, segment: { from: string; to: string } | null): string {
  const base = englishMonthYear(payPeriod);
  if (!segment) return base;
  const short = (iso: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))),
    );
  };
  return `${base} (${short(segment.from)} - ${short(segment.to)})`;
}

const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'cash'] as const;

export type PayslipPdfStrings = {
  labels: PayslipPdfLabels;
  borneLabels: Record<EmployerBorneKey, string>;
  /** "Regular" / "Bonus" — the cycle half of the letterhead subtitle. */
  cycleLabel: string | null;
  /** The stored enums, resolved to display text. Null when the record does not carry one. */
  employmentType: string | null;
  paymentMethod: string | null;
};

/**
 * `runType`, `employmentType` and `paymentMethod` are STORED ENUM VALUES, and each is looked up against a
 * closed list before being used as a message key. A value outside the list resolves to null (the field is
 * then omitted from the document) rather than being interpolated into `t()`, which would raise
 * MISSING_MESSAGE at render time — a class of bug that passes tsc, the suite and `next build` and only
 * shows up on the page.
 */
export async function payslipPdfStrings(p: {
  /** The stored `YYYY-MM`. Printed as a month name; the sortable form still names the download. */
  payPeriod: string;
  payDate: string | null;
  ytdYear: string;
  runType: string | null;
  employmentType: string | null;
  paymentMethod: string | null;
  /**
   * 3c88d593 — the entity segment this slip covers, when a mid-month transfer split the month
   * (core/payslip-segment.ts reads it off the payslip's own snapshot). Absent/null ⇒ the period line is
   * the plain month name, exactly as before.
   */
  segment?: { from: string; to: string } | null;
}): Promise<PayslipPdfStrings> {
  const t = await getTranslations('me.payslip');
  const tIp = await getTranslations('payroll.individualPayslip');
  const tTxn = await getTranslations('payroll.transactions');

  const known = <T extends string>(list: readonly T[], v: string | null): T | null =>
    v != null && (list as readonly string[]).includes(v) ? (v as T) : null;
  const cycle = known(CYCLES, p.runType);
  const empType = known(EMPLOYMENT_TYPES, p.employmentType);
  const payMethod = known(PAYMENT_METHODS, p.paymentMethod);

  return {
    borneLabels: { epf: t('epf'), socso: t('socso'), skbbk: t('skbbk'), eis: t('eis'), tax: t('pcb') },
    cycleLabel: cycle ? tTxn(`individual.cycle.${cycle}`) : null,
    employmentType: empType ? tIp(`employmentType_${empType}`) : null,
    paymentMethod: payMethod ? tIp(`paymentMethod_${payMethod}`) : null,
    labels: {
      title: t('pdfTitle'),
      payPeriod: t('payPeriodLabel'),
      employeeCode: tIp('fieldEmployeeCode'),
      earnings: t('earnings'),
      basicSalary: t('basicSalary'),
      allowances: t('allowances'),
      overtime: t('overtime'),
      bonus: t('bonus'),
      grossPay: t('grossPay'),
      deductions: t('deductionsHeading'),
      epf: t('epf'),
      socso: t('socso'),
      skbbk: t('skbbk'),
      eis: t('eis'),
      pcb: t('pcb'),
      cp38: t('cp38'),
      otherDeductions: t('otherDeductions'),
      // e2632276 — the two named absence lines + the bare "days" word appended to each count.
      unpaidLeaveLine: t('unpaidLeaveLine'),
      absentLine: t('absentLine'),
      dayUnit: t('dayUnit'),
      daysUnit: t('daysUnit'),
      totalDeductions: t('totalDeductions'),
      netPay: t('netPay'),
      employerContributions: t('employerContributionsHeading'),
      totalEmployerCost: t('totalEmployerCost'),
      generatedNote: t('generatedNote'),
      claim: t('claim'),
      employerBorne: t('employerBorneHeading'),
      employerBorneTotal: t('employerBorneTotal'),
      employerBorneNote: t('employerBorneNote'),
      documentSubtitle: tIp('pdfSubtitle'),
      paymentDate: p.payDate ? tIp('payDateLine', { date: p.payDate }) : '',
      employmentInfo: tIp('employmentInfoHeading'),
      department: tIp('fieldDepartment'),
      position: tIp('fieldPosition'),
      grade: tIp('fieldGrade'),
      employmentType: tIp('fieldEmploymentType'),
      daysWorked: tIp('fieldDaysWorked'),
      currency: tIp('fieldCurrency'),
      ic: tIp('fieldIc'),
      passport: tIp('fieldPassport'),
      epfNumber: tIp('fieldEpfNumber'),
      socsoNumber: tIp('fieldSocsoNumber'),
      taxNumber: tIp('fieldTaxNumber'),
      totalEarnings: tIp('totalEarnings'),
      hrdf: t('hrdf'),
      employerContributionsNote: tIp('employerContributionsNote'),
      paymentInformation: tIp('paymentInfoHeading'),
      paymentMethod: tIp('fieldPaymentMethod'),
      bankName: tIp('fieldBankName'),
      bankAccount: tIp('fieldBankAccount'),
      ytdHeading: tIp('ytdHeading', { year: p.ytdYear }),
      ytdItem: tIp('ytdItem'),
      ytdCurrent: tIp('ytdCurrent'),
      ytdToDate: tIp('ytdToDate'),
      detailNotRecorded: tIp('earningsDetailNote'),
      earningsContinued: tIp('earningsContinued'),
      periodLabel: englishPeriodLabel(p.payPeriod, p.segment ?? null),
      // f35f758a — the Non-payable box. `nonPayableNote` reuses `me.payslip.recordLinesNote`, which already
      // says exactly the right thing ("recorded for your reference only — these do not affect your gross or
      // net pay") and which is only NOW true of everything it labels: the same sentence used to head a
      // mixed list that included one-off payments the employee really did receive.
      nonPayable: t('nonPayableHeading'),
      nonPayableTotal: t('nonPayableTotal'),
      nonPayableNote: t('recordLinesNote'),
    },
  };
}
