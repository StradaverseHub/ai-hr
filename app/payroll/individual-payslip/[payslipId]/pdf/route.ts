import { selectPayslipInformation } from '@/core/payslip-information';
import { payslipInformationLabels } from '@/lib/payslip-information-labels';
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
import { getCompanyLogo } from '@/core/admin';
import { buildPayslipPdfData, renderPayslipPdf } from '@/lib/payslip-pdf';
import { payslipPdfStrings } from '@/lib/payslip-pdf-strings';
// 3c88d593 — the entity segment this slip covers, read off the payslip's own snapshot (pure, db-free).
import { payslipSegmentOf } from '@/core/payslip-segment';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ payslipId: string }> }) {
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
    payPeriod: p.payPeriod,
    payDate: p.payDate,
    ytdYear: year,
    runType: p.runType,
    // r360 — the configured Pay Cycle's NAME, so the letterhead reads "Payroll payslip · Monthly" instead
    // of the kernel's run-type word. `payslipPdfStrings` runs it through the ONE shared rule
    // (core/payslip-cycle-label.ts) that the Individual Payslip screen also calls, and falls back to the
    // run-type word for a batch that names no cycle — which is most batches on production.
    cycleName: p.cycleName,
    employmentType: p.employmentType,
    paymentMethod: p.paymentMethod,
    // 3c88d593 — when a mid-month entity transfer split the month, the document says which days it paid.
    // Null on every other payslip ⇒ the period line is unchanged.
    // 1b0943d5 — now derived from the slip's COVERAGE (columns since 0446, the r194 stamp before them):
    // "segmented" means the window is narrower than the pay period, so the document and the completeness
    // control read one fact rather than two that could disagree.
    segment: payslipSegmentOf(p, p.payPeriod),
  });

  // `payslipForReview` names the employee `employeeName` (the list-read convention); the PDF builder takes
  // `employee` (the payslipDetail convention). Bridged here rather than renaming either, so neither the
  // ESS route nor the History screen has to change for this one.
  const data = buildPayslipPdfData({ ...p, employee: p.employeeName }, strings.borneLabels, {
    informationRows: selectPayslipInformation({ ...p, employee: p.employeeName, employmentType: strings.employmentType }, p.informationFields, await payslipInformationLabels(p.identityIsPassport)),
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

  // Same filename shape as the ESS route, so a reviewer's copy and the employee's copy of one run are
  // recognisably the same document rather than two files that look unrelated.
  const runTag = p.runType === 'regular' && p.runSeq <= 1 ? '' : `-${p.runType}${p.runSeq > 1 ? `-${p.runSeq}` : ''}`;
  // The SORTABLE period still names the file. The month name is for reading, not for a filename that has
  // to sort beside eleven others in a download folder.
  const fname = `payslip-${p.payPeriod}${runTag}-${p.employeeCode ?? 'employee'}`.replace(/[^a-zA-Z0-9._-]+/g, '-');

  // f35f758a — "Preview" puts THE REAL FILE on screen. `?inline=1` asks for the same bytes with an inline
  // disposition so a viewer can frame them; without it the response is unchanged and still downloads.
  // Same route, same bytes, so what is previewed and what is downloaded cannot disagree — which is the
  // whole reason Preview replaced a browser print of the web page. The pattern (and `nosniff` beside it)
  // is app/admin/personnel/[employmentId]/document/[docId]/route.ts; the content type here is a constant
  // this route produces itself, so there is no untrusted type to gate on.
  const inline = new URL(req.url).searchParams.get('inline') === '1';
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fname}.pdf"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
