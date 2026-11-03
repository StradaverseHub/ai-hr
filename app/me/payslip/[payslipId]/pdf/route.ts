import { getSession } from '@/lib/session';
import { myPayslipDocument } from '../../document';
import { myPayslipPdfFile } from '../../pdf-file';
import { recordPayslipOpened } from '@/core/payroll-audit/access-log';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function GET(req:Request,{params}:{params:Promise<{payslipId:string}>}) {
  const {payslipId}=await params;
  if(!UUID.test(payslipId))return new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}});
  const document=await myPayslipDocument(await getSession(),payslipId);
  if(!document)return new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}});
  // AI v2 P2-2b: a download of one's own released payslip counts as an open for the Audit loop. Best effort: a count that
  // could not be written never stops an employee getting their payslip.
  await recordPayslipOpened(await getSession(),{payslipId,channel:'pdf'}).catch(()=>null);
  // M09 — the render and the file name are shared with the mobile v2 route (../../pdf-file.ts), so both hand
  // over the same bytes under the same name. Only the transport below is this route's own.
  const {bytes,fileName}=await myPayslipPdfFile(document);
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${new URL(req.url).searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment'}; filename="${fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
