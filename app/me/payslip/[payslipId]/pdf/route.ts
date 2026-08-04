// ADR-0036 (#22) — stream a payslip as a downloadable A5 PDF. ABAC is inherited from payslipDetail,
// which is RLS-gated to own-or-admin, so an employee can only fetch their own payslip.
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { payslipDetail } from '@/core/payroll';
import { buildPayslipPdfData, renderPayslipPdf } from '@/lib/payslip-pdf';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => Number(v ?? 0);

export async function GET(_req: Request, { params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) return new Response('Not found', { status: 404 });
  const s = await getSession();
  const p = await payslipDetail(s, payslipId); // RLS-gated: own payslip or admin
  if (!p) return new Response('Not found', { status: 404 });

  // 3c473773 — the data is assembled by the shared builder so this PDF, the on-screen payslip and the
  // admin review copy cannot disagree about which box an amount is in or whether the employer funded a
  // deduction. It reads THIS payslip's stored snapshot, never today's settings.
  const t = await getTranslations('me.payslip');
  const data = buildPayslipPdfData(p, {
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
