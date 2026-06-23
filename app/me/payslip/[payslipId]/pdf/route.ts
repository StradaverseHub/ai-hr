// ADR-0036 (#22) — stream a payslip as a downloadable A5 PDF. ABAC is inherited from payslipDetail,
// which is RLS-gated to own-or-admin, so an employee can only fetch their own payslip.
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { payslipDetail } from '@/core/payroll';
import { renderPayslipPdf, type PayslipPdfData } from '@/lib/payslip-pdf';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => Number(v ?? 0);

export async function GET(_req: Request, { params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) return new Response('Not found', { status: 404 });
  const s = await getSession();
  const p = await payslipDetail(s, payslipId); // RLS-gated: own payslip or admin
  if (!p) return new Response('Not found', { status: 404 });

  const st = (p.statutory ?? {}) as Record<string, number>;
  const data: PayslipPdfData = {
    employee: p.employee,
    employeeCode: p.employeeCode,
    company: p.company,
    companyReg: p.companyReg,
    payPeriod: p.payPeriod,
    basic: num(p.basic),
    allowance: num(p.allowance),
    overtime: num(p.overtime),
    bonus: num(p.bonus),
    gross: num(p.gross),
    epfEmployee: num(st.epfEmployee),
    socsoEmployee: num(st.socsoEmployee),
    socsoSkbbk: num(st.socsoSkbbk),
    eisEmployee: num(st.eisEmployee),
    pcb: num(st.pcb),
    otherDeductions: num(p.otherDeductions),
    totalDeductions: num(p.totalDeductions),
    net: num(p.net),
    epfEmployer: num(st.epfEmployer),
    socsoEmployer: num(st.socsoEmployer),
    eisEmployer: num(st.eisEmployer),
    employerCost: num(p.employerCost),
    daysWorked: p.daysWorked != null ? num(p.daysWorked) : null,
  };

  const t = await getTranslations('me.payslip');
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
    otherDeductions: t('otherDeductions'),
    totalDeductions: t('totalDeductions'),
    netPay: t('netPay'),
    employerContributions: t('employerContributionsHeading'),
    totalEmployerCost: t('totalEmployerCost'),
    proratedNote: p.daysWorked != null ? t('proratedNote', { days: num(p.daysWorked) }) : '',
    generatedNote: t('generatedNote'),
  });

  const fname = `payslip-${p.payPeriod}-${p.employeeCode ?? 'employee'}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
