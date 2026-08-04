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
 * same `buildPayslipPdfData`, so the review copy and the issued copy cannot differ. Labels come from the
 * existing `me.payslip` namespace; no new PDF strings were needed.
 */
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { payslipForReview } from '@/core/payroll-view';
import { buildPayslipPdfData, renderPayslipPdf } from '@/lib/payslip-pdf';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => Number(v ?? 0);

export async function GET(_req: Request, { params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) return new Response('Not found', { status: 404 });
  const { s, scopeIds } = await scopedAdmin();
  const p = await payslipForReview(s, { companyIds: scopeIds, payslipId });
  if (!p) return new Response('Not found', { status: 404 });

  const t = await getTranslations('me.payslip');
  // `payslipForReview` names the employee `employeeName` (the list-read convention); the PDF builder takes
  // `employee` (the payslipDetail convention). Bridged here rather than renaming either, so neither the
  // ESS route nor the History screen has to change for this one.
  const data = buildPayslipPdfData({ ...p, employee: p.employeeName }, {
    epf: t('epf'), socso: t('socso'), skbbk: t('skbbk'), eis: t('eis'), tax: t('pcb'),
  });

  const bytes = await renderPayslipPdf(data, {
    title: t('pdfTitle'),
    payPeriod: t('payPeriodLabel'),
    employeeCode: t('employeeCodeLabel'),
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
    totalDeductions: t('totalDeductions'),
    netPay: t('netPay'),
    employerContributions: t('employerContributionsHeading'),
    totalEmployerCost: t('totalEmployerCost'),
    proratedNote: p.daysWorked != null ? t('proratedNote', { days: num(p.daysWorked) }) : '',
    generatedNote: t('generatedNote'),
    claim: t('claim'),
    employerBorne: t('employerBorneHeading'),
    employerBorneTotal: t('employerBorneTotal'),
    employerBorneNote: t('employerBorneNote'),
  });

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
