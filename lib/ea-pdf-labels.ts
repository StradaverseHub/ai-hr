/**
 * r220 (item 61c2e30f) — every localized caption the C.P.8A needs, resolved ONCE.
 *
 * WHY THIS MODULE EXISTS. Two routes now print this form: the employee's own filled statement
 * (`app/me/ea/[employmentId]/pdf`) and the blank copy the reporter asked for (`app/payroll/ea/blank`).
 * `EaPdfLabels` is fifty-odd required properties, so each route would otherwise assemble its own fifty-line
 * object by hand — and two hand-maintained copies of one statutory form's captions is how one of them
 * quietly keeps a caption the other reworded, on a document whose whole purpose is that the blank and the
 * filled version are THE SAME PAGE. tsc keeps them identical by construction instead.
 *
 * This is the shape `lib/payslip-pdf-strings.ts` already established for the payslip's two routes, and the
 * reason is the same one the EA renderer's own header gives for staying one renderer.
 *
 * ONE NAMESPACE. `payroll.ea` owns every caption on the form. The agency's own page furniture — the form
 * number, the masthead, the banner, the officer box's captions — is NOT here and never will be: it is
 * drawn from `EA_FORM_WORDS` in Malay in both languages, because translating a form number produces a
 * document that no longer matches the form (see the `EaPdfLabels` block comment in lib/ea-pdf.ts).
 */
import { getTranslations } from 'next-intl/server';

import type { EaPdfLabels } from './ea-pdf';

/**
 * What the footnote strip beneath the form says, which is the ONE caption that differs between a filled
 * statement and a blank one.
 *
 * A filled statement's disclaimer names the year of assessment and the statutory table version it was
 * produced from, and tells the reader which boxes payroll fed and which HR must enter. A BLANK form was
 * produced from no payroll at all, so every clause of that is false on it — "Generated from payroll for YA
 * 2026" on a page with nothing in it is an assertion about a payroll run that did not happen (AGENTS 28).
 * `payroll.ea.blankDisclaimer` says what the blank copy actually is instead.
 */
export type EaLabelMode =
  | { blank: true }
  | { blank?: false; year: string; version: string };

/**
 * The label bundle for one locale.
 *
 * `locale` is the DOCUMENT's language, not the viewer's — both routes allowlist `en` / `ms` and fall back
 * to the request locale, because LHDN accepts the C.P.8A in either and an employer may need both in the
 * same year from the same admin session.
 */
export async function eaPdfLabels(locale: string, mode: EaLabelMode): Promise<EaPdfLabels> {
  const t = await getTranslations({ locale, namespace: 'payroll.ea' });
  return {
    title: t('title'),
    sectionAEmployeeParticulars: t('sectionAEmployeeParticulars'),
    name: t('name'),
    jobTitle: t('jobTitle'),
    employeeNo: t('employeeNo'),
    icNo: t('icNo'),
    passportNo: t('passportNo'),
    epfNo: t('epfNo'),
    socsoNo: t('socsoNo'),
    childrenTaxRelief: t('childrenTaxRelief'),
    partYearNote: t('partYearNote'),
    startedOn: t('startedOn'),
    leftOn: t('leftOn'),
    sectionBEmploymentIncome: t('sectionBEmploymentIncome'),
    sectionBExcluding: t('sectionBExcluding'),
    grossSalary: t('grossSalary'),
    feesCommissionBonus: t('feesCommissionBonus'),
    tipsPerquisitesOther: t('tipsPerquisitesOther'),
    paymentDetail: t('paymentDetail'),
    stateWhat: t('stateWhat'),
    addressCue: t('addressCue'),
    taxBorneByEmployer: t('taxBorneByEmployer'),
    esos: t('esos'),
    gratuity: t('gratuity'),
    periodFrom: t('periodFrom'),
    periodTo: t('periodTo'),
    incomeType: t('incomeType'),
    arrears: t('arrears'),
    benefitsInKind: t('benefitsInKind'),
    livingAccommodation: t('livingAccommodation'),
    unapprovedFundRefund: t('unapprovedFundRefund'),
    compensation: t('compensation'),
    sectionCPensionOther: t('sectionCPensionOther'),
    pension: t('pension'),
    annuity: t('annuity'),
    formTotal: t('formTotal'),
    sectionDTotalDeductions: t('sectionDTotalDeductions'),
    monthlyTaxDeduction: t('monthlyTaxDeduction'),
    cp38Deductions: t('cp38Deductions'),
    zakatViaSalary: t('zakatViaSalary'),
    // da4fc817 — Section D's four missing lines, Section E's fund name and Section F's own heading.
    donations: t('donations'),
    tp1ClaimHeading: t('tp1ClaimHeading'),
    tp1Relief: t('tp1Relief'),
    zakatOther: t('zakatOther'),
    childRelief: t('childRelief'),
    sectionFExemptAllowances: t('sectionFExemptAllowances'),
    fundName: t('fundName'),
    contributionAmount: t('contributionAmount'),
    sectionEContributions: t('sectionEContributions'),
    eisSip: t('eisSip'),
    notOfficialStrip: t('notOfficialStrip'),
    disclaimer: mode.blank
      ? t('blankDisclaimer')
      : t('disclaimer', { year: mode.year, version: mode.version }),
    // 1.2.6 — the "Amended" marker. A blank form has no overrides, so the renderer never prints it there;
    // it is still resolved, because `EaPdfLabels` requires it and a mode-dependent hole in the bundle is a
    // hole a later edit can widen.
    amendedNote: t('override.amendedNote'),
  };
}
