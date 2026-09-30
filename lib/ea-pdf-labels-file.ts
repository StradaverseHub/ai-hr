/**
 * THE SAME LABEL BUNDLE, RESOLVED FROM THE CATALOGUE **FILES** RATHER THAN FROM A REQUEST (r372).
 *
 * `eaPdfLabels` (beside this) is what the two routes use: next-intl, a request locale, and the
 * catalogue's own fallback chain. Neither the measuring script nor the grid guard has a request, and
 * both need to RENDER this form to compare it with LHDN's own file —
 * `scripts/measure-ea-official-pdf.ts --ours ms` and `test/ea-agency-grid.test.ts`. So this reads
 * `messages/<locale>.json` off disk and returns the identical shape.
 *
 * ⚠️ IT IS NOT A SECOND RESOLVER FOR THE PRODUCT, and nothing that serves a page may call it: it has no
 * fallback, no ICU formatting and no locale negotiation, and it THROWS on a missing key instead of
 * degrading. That is what a measuring tool should do and the opposite of what a route should do. `tsc`
 * keeps the two key lists identical because both must satisfy `EaPdfLabels`.
 */
import { readFileSync } from 'node:fs';

import type { EaPdfLabels } from './ea-pdf';

/** Every caption the printed C.P.8A needs, read straight out of `messages/<locale>.json`. */
export function eaPdfLabelsFromCatalogue(locale: string): EaPdfLabels {
  // Resolved against THIS MODULE, not the process's cwd: the script is run from wherever somebody
  // happens to be standing, and a silently-missing catalogue would read as a missing caption.
  const messages = JSON.parse(
    readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const L = (key: string): string => {
    let node: unknown = (messages as { payroll?: { ea?: unknown } }).payroll?.ea;
    for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
    if (typeof node !== 'string') throw new Error(`messages/${locale}.json is missing payroll.ea.${key}`);
    return node;
  };
  return {
    title: L('title'),
    sectionAEmployeeParticulars: L('sectionAEmployeeParticulars'),
    name: L('name'),
    jobTitle: L('jobTitle'),
    employeeNo: L('employeeNo'),
    icNo: L('icNo'),
    passportNo: L('passportNo'),
    epfNo: L('epfNo'),
    socsoNo: L('socsoNo'),
    childrenTaxRelief: L('childrenTaxRelief'),
    partYearNote: L('partYearNote'),
    startedOn: L('startedOn'),
    leftOn: L('leftOn'),
    sectionBEmploymentIncome: L('sectionBEmploymentIncome'),
    sectionBExcluding: L('sectionBExcluding'),
    grossSalary: L('grossSalary'),
    feesCommissionBonus: L('feesCommissionBonus'),
    tipsPerquisitesOther: L('tipsPerquisitesOther'),
    paymentDetail: L('paymentDetail'),
    stateWhat: L('stateWhat'),
    addressCue: L('addressCue'),
    taxBorneByEmployer: L('taxBorneByEmployer'),
    esos: L('esos'),
    gratuity: L('gratuity'),
    periodFrom: L('periodFrom'),
    periodTo: L('periodTo'),
    incomeType: L('incomeType'),
    arrears: L('arrears'),
    benefitsInKind: L('benefitsInKind'),
    livingAccommodation: L('livingAccommodation'),
    unapprovedFundRefund: L('unapprovedFundRefund'),
    compensation: L('compensation'),
    sectionCPensionOther: L('sectionCPensionOther'),
    pension: L('pension'),
    annuity: L('annuity'),
    formTotal: L('formTotal'),
    sectionDTotalDeductions: L('sectionDTotalDeductions'),
    monthlyTaxDeduction: L('monthlyTaxDeduction'),
    cp38Deductions: L('cp38Deductions'),
    zakatViaSalary: L('zakatViaSalary'),
    donations: L('donations'),
    tp1ClaimHeading: L('tp1ClaimHeading'),
    tp1Relief: L('tp1Relief'),
    zakatOther: L('zakatOther'),
    childRelief: L('childRelief'),
    sectionFExemptAllowances: L('sectionFExemptAllowances'),
    fundName: L('fundName'),
    contributionAmount: L('contributionAmount'),
    sectionEContributions: L('sectionEContributions'),
    amendedNote: L('override.amendedNote'),
  };
}
