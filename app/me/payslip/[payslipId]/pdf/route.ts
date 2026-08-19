// ADR-0036 (#22) — stream a payslip as a downloadable PDF. ABAC is inherited from payslipDetail,
// which is RLS-gated to own-or-admin AND carries the ESS release gate, so an employee can only fetch
// their own payslip and only once it has been released to them.
//
// 5c198931 — the employee now gets THE SAME DOCUMENT the reviewer approved. This route used to render a
// half-page A5 with four lumped earnings rows and nothing else; the admin review route had already grown
// past it. Both now share `payslipPdfStrings` + `buildPayslipPdfData` + `renderPayslipPdf`, so the only
// difference between the two files is which fenced read produced the row.
import { getSession } from '@/lib/session';
import { payslipDetail } from '@/core/payroll';
import { sumPayslipYtd } from '@/core/payroll-view';
import { myPayslips } from '@/core/read';
import { getCompanyLogo } from '@/core/admin';
import { buildPayslipPdfData, renderPayslipPdf } from '@/lib/payslip-pdf';
import { payslipPdfStrings } from '@/lib/payslip-pdf-strings';
// 3c88d593 — the entity segment this slip covers. The EMPLOYEE's own copy needs it most: after a
// mid-month transfer they hold two documents for one month, from two different employers.
import { payslipSegmentOf } from '@/core/payslip-segment';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) return new Response('Not found', { status: 404 });
  const s = await getSession();
  const p = await payslipDetail(s, payslipId); // RLS-gated: own payslip or admin, and released-only
  if (!p) return new Response('Not found', { status: 404 });

  const year = p.payPeriod.slice(0, 4);
  // Year-to-date from the employee's OWN payslips, and only the RELEASED ones. The admin review copy sums
  // every processed payslip in the year because a reviewer is entitled to see a run before release; an
  // employee is not, so their column must not contain a month they cannot yet open. By the time this route
  // can serve a payslip at all, that payslip is released and therefore in both totals.
  const [mine, logo] = await Promise.all([
    myPayslips(s, [p.employmentId]),
    getCompanyLogo(s, p.companyId),
  ]);
  const ytdRows = mine.filter((r) => r.released && r.payPeriod.startsWith(`${year}-`));

  const strings = await payslipPdfStrings({
    payPeriod: p.payPeriod,
    payDate: p.payDate,
    ytdYear: year,
    runType: p.runType,
    employmentType: p.employmentType,
    paymentMethod: p.paymentMethod,
    // 1b0943d5 — derived from the slip's COVERAGE window (see the admin PDF route for the full note).
    segment: payslipSegmentOf(p, p.payPeriod),
  });

  // 3c473773 — the data is assembled by the shared builder so this PDF, the on-screen payslip and the
  // admin review copy cannot disagree about which box an amount is in or whether the employer funded a
  // deduction. It reads THIS payslip's stored snapshot, never today's settings.
  const data = buildPayslipPdfData(p, strings.borneLabels, {
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
    // f35f758a — the PDF takes the FULL account number; the screens keep the masked one. Both forms
    // come off the same read (see PayslipReviewRow.bankAccountFull for the exposure this creates).
    bankAccount: p.bankAccountFull,
    ytd: sumPayslipYtd(ytdRows),
    ytdYear: year,
    logo: logo ? { bytes: new Uint8Array(logo.content), mimeType: logo.mimeType } : null,
  });

  const bytes = await renderPayslipPdf(data, strings.labels);

  // Disambiguate the filename so two cycles in one month don't collide (and silently overwrite on
  // download). A sole regular run keeps the legacy `payslip-<period>-<code>`; non-regular or repeated
  // runs append the run identity. Sanitizer below strips anything outside [A-Za-z0-9._-].
  const runTag =
    p.runType === 'regular' && p.runSeq <= 1
      ? ''
      : `-${p.runType}${p.runSeq > 1 ? `-${p.runSeq}` : ''}`;
  const fname = `payslip-${p.payPeriod}${runTag}-${p.employeeCode ?? 'employee'}`.replace(
    /[^a-zA-Z0-9._-]+/g,
    '-',
  );
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
