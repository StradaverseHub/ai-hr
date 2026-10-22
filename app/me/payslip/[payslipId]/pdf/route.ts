import { getSession } from '@/lib/session';
import { renderPayslipPdf } from '@/lib/payslip-pdf';
import { myPayslipDocument } from '../../document';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function GET(req:Request,{params}:{params:Promise<{payslipId:string}>}) {
  const {payslipId}=await params;
  if(!UUID.test(payslipId))return new Response('Not found',{status:404});
  const document=await myPayslipDocument(await getSession(),payslipId);
  if(!document)return new Response('Not found',{status:404});
  const {p,data,strings}=document;
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
      'Content-Disposition': `${new URL(req.url).searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment'}; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
