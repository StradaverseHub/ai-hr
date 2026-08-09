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
  daysWorked: number | null;
  payDate: string | null;
  ytdYear: string;
  rulesetVersion: string | null;
  runType: string | null;
  employmentType: string | null;
  paymentMethod: string | null;
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
      daysUnit: t('daysUnit'),
      totalDeductions: t('totalDeductions'),
      netPay: t('netPay'),
      employerContributions: t('employerContributionsHeading'),
      totalEmployerCost: t('totalEmployerCost'),
      // Interpolated here, printed verbatim by the renderer: pluralisation is next-intl's job, not the
      // PDF's. An absent day count prints nothing at all rather than "Prorated on 0 days".
      proratedNote: p.daysWorked != null ? t('proratedNote', { days: p.daysWorked }) : '',
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
      // 97a9b0ab — the ruleset the run was calculated under. Empty when the payslip does not record one
      // (every run before the provenance stamp); the footer then simply omits the clause.
      provenanceNote: p.rulesetVersion ? t('provenanceFooter', { ruleset: p.rulesetVersion }) : '',
    },
  };
}
