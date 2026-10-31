import 'server-only';
import type { SessionContext } from '@/db/client';
import { myPayslipDetail, sumPayslipYtd, sumPayslipEmployerPeriodTotals } from '@/packs/payroll/service';
import { myOwnPayslips } from '@/core/read';
import { getCompanyLogo } from '@/core/admin';
import { selectPayslipInformation, payslipInformationData } from '@/packs/payroll/service';
import { payslipInformationLabels } from '@/lib/payslip-information-labels';
import { buildPayslipPdfData } from '@/lib/payslip-pdf';
import { payslipPdfStrings } from '@/lib/payslip-pdf-strings';
import { payslipSegmentOf } from '@/packs/payroll/service';

/** Shared own-only document model. Preview, download and screen use the same canonical assembly. */
export async function myPayslipDocument(s:SessionContext,payslipId:string) {
  const p = await myPayslipDetail(s, payslipId);
  if (!p) return null;

  const year = p.payPeriod.slice(0, 4);
  // Year-to-date from the employee's OWN payslips, and only the RELEASED ones. The admin review copy sums
  // every processed payslip in the year because a reviewer is entitled to see a run before release; an
  // employee is not, so their column must not contain a month they cannot yet open. By the time this route
  // can serve a payslip at all, that payslip is released and therefore in both totals.
  const [mine, logo] = await Promise.all([
    myOwnPayslips(s, [p.employmentId]),
    getCompanyLogo(s, p.companyId),
  ]);
  // Committed imported history contributes to the own YTD basis without issuing an imported payslip.
  const ytdRows = mine.filter((r) => (r.released || r.historyImported) && r.payPeriod.startsWith(`${year}-`));

  const strings = await payslipPdfStrings({
    payPeriod: p.payPeriod,
    payDate: p.payDate,
    ytdYear: year,
    runType: p.runType,
    // r360 — the configured Pay Cycle's name, fed here TOO and not only to the admin review route. The two
    // routes print ONE document (same builder, same renderer, same strings module); handing the cycle name
    // to one of them would print "Monthly" on the reviewer's copy and "Regular" on the employee's copy of
    // the very same payslip, which is the drift this module was created to prevent.
    cycleName: p.cycleName,
    employmentType: p.employmentType,
    paymentMethod: p.paymentMethod,
    // 1b0943d5 — derived from the slip's COVERAGE window (see the admin PDF route for the full note).
    segment: payslipSegmentOf(p, p.payPeriod),
  });

  // 3c473773 — the data is assembled by the shared builder so this PDF, the on-screen payslip and the
  // admin review copy cannot disagree about which box an amount is in or whether the employer funded a
  // deduction. It reads THIS payslip's stored snapshot, never today's settings.
  const data = buildPayslipPdfData(p, strings.borneLabels, {
    // r392 (23bd49d9) — the payment facts are setting fields now: the translated method (never the raw
    // enum), the FULL account number and the cycle label, exactly as the review screen feeds them.
    informationRows: selectPayslipInformation(payslipInformationData(p, { employee: p.employee, employmentType: strings.employmentType,
      paymentMethod: strings.paymentMethod, bankAccount: p.bankAccountFull, payrollCycle: strings.cycleLabel }), p.informationFields, await payslipInformationLabels(p.identityIsPassport)),
    currency: p.currency,
    payDate: p.payDate,
    cycleLabel: strings.cycleLabel,
    identityNumber: p.identityNumber,
    identityIsPassport: p.identityIsPassport,
    department: p.department,
    position: p.position,
    jobGrade: p.jobGrade,
    employmentType: strings.employmentType,
    epfNumber: p.epfNumber,
    socsoNumber: p.socsoNumber,
    taxNumber: p.taxNumber,
    paymentMethod: strings.paymentMethod,
    bankName: p.bankName,
    // f35f758a — the PDF takes the FULL account number, as the review screen does (b19042d0). Both forms
    // come off the same read (see PayslipReviewRow.bankAccountFull for the exposure this creates).
    bankAccount: p.bankAccountFull,
    ytd: sumPayslipYtd(ytdRows),
    employerPeriodTotals: sumPayslipEmployerPeriodTotals(ytdRows, p.payPeriod),
    ytdYear: year,
    logo: logo ? { bytes: new Uint8Array(logo.content), mimeType: logo.mimeType } : null,
  });

  return {p,data,strings};
}
