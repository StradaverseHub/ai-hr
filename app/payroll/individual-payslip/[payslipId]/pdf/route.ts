/**
 * Feedback 169e3c24 — the admin review copy of a payslip as a PDF, available BEFORE release.
 *
 * THE ESS RELEASE GATE IS NOT WEAKENED. `payslipDetail` (core/payroll.ts) returns null until the batch is
 * closed AND its release instant has passed, and `app/me/payslip/[payslipId]/pdf/route.ts` still reads
 * through it — that is what stops an employee downloading a payslip before it is published, and it stays
 * exactly as it is. This route does NOT call it. It reads `payslipForReview`, a separate admin read fenced
 * on the caller's authorised companyIds, which is the same decision Transaction View → History already
 * made and documented: a reviewer's whole job is to check a run before anyone else sees it.
 *
 * FENCE: scopedAdmin() (admin + company scope). An out-of-scope or unknown payslipId returns 404, so a
 * tampered id is indistinguishable from a missing payslip and cannot confirm that one exists elsewhere.
 *
 * The document itself is `renderPayslipPdf` — the same renderer the employee's own PDF uses, fed by the
 * same `buildPayslipPdfData` and the same `payslipPdfStrings`, so the review copy and the issued copy
 * cannot differ.
 *
 * 5c198931 — the document grew a letterhead logo, an employee panel, named pay items, payment details and
 * a year-to-date column. Everything it added is READ-SIDE: three extra reads (the company logo, the
 * year's payslips, nothing else), no write, no recomputation, and not one figure that this route decides.
 */
import { scopedAdmin } from '@/lib/scope';
import { listProcessedPayslipsAcross, payslipForReview, sumPayslipYtd } from '@/core/payroll-view';
import { payslipProvenance } from '@/core/payslip-recompute';
import { getCompanyLogo } from '@/core/admin';
import { buildPayslipPdfData, renderPayslipPdf } from '@/lib/payslip-pdf';
import { payslipPdfStrings } from '@/lib/payslip-pdf-strings';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => Number(v ?? 0);

export async function GET(_req: Request, { params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) return new Response('Not found', { status: 404 });
  const { s, scopeIds } = await scopedAdmin();
  const p = await payslipForReview(s, { companyIds: scopeIds, payslipId });
  if (!p) return new Response('Not found', { status: 404 });

  const year = p.payPeriod.slice(0, 4);
  // Year-to-date is summed from the SAME read the Individual Payslip screen lists this employee's months
  // with, through the SAME helper, so the screen and the document cannot disagree about the year.
  // The logo is the company's own uploaded file — the same bytes the Organization screen and the on-screen
  // letterhead show. Absent ⇒ the legal name stands alone; no placeholder mark is invented.
  const [ytdRows, logo] = await Promise.all([
    listProcessedPayslipsAcross(s, { companyIds: scopeIds, year: Number(year), employmentId: p.employmentId }),
    getCompanyLogo(s, p.companyId),
  ]);

  const strings = await payslipPdfStrings({
    daysWorked: p.daysWorked != null ? num(p.daysWorked) : null,
    payDate: p.payDate,
    ytdYear: year,
    rulesetVersion: payslipProvenance(p.statutory).rulesetVersion,
    runType: p.runType,
    employmentType: p.employmentType,
    paymentMethod: p.paymentMethod,
  });

  // `payslipForReview` names the employee `employeeName` (the list-read convention); the PDF builder takes
  // `employee` (the payslipDetail convention). Bridged here rather than renaming either, so neither the
  // ESS route nor the History screen has to change for this one.
  const data = buildPayslipPdfData({ ...p, employee: p.employeeName }, strings.borneLabels, {
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
    bankAccountMasked: p.bankAccountMasked,
    ytd: sumPayslipYtd(ytdRows),
    ytdYear: year,
    logo: logo ? { bytes: new Uint8Array(logo.content), mimeType: logo.mimeType } : null,
  });

  const bytes = await renderPayslipPdf(data, strings.labels);

  // Same filename shape as the ESS route, so a reviewer's copy and the employee's copy of one run are
  // recognisably the same document rather than two files that look unrelated.
  const runTag = p.runType === 'regular' && p.runSeq <= 1 ? '' : `-${p.runType}${p.runSeq > 1 ? `-${p.runSeq}` : ''}`;
  const fname = `payslip-${p.payPeriod}${runTag}-${p.employeeCode ?? 'employee'}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
