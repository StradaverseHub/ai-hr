import {scopedAdmin} from '@/lib/scope';
import {readIndividualImportWorkbook} from '@/packs/payroll/service';

export async function GET(_request: Request, {params}: {params: Promise<{jobId: string}>}) {
  const {s, scopeIds} = await scopedAdmin();
  const {jobId} = await params;
  const workbook = await readIndividualImportWorkbook(s, jobId, scopeIds).catch(() => undefined);
  if (!workbook) return new Response(null, {status: 404});
  return new Response(new Uint8Array(workbook.source), {headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="original-workbook.xlsx"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }});
}
