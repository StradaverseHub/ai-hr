/**
 * CP39 e-Data PCB text-file download (Layer-B DRAFT — not for submission until verified against
 * the live e-PCB Plus portal). Byte layout: LHDN MTD spec Exhibit 4 (REPORT-FORMATS.md §1).
 * Each download records an append-only statutory_report artefact + domain event.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { cp39FileForBatch, Cp39NotReadyError } from '@/localization/my/cp39-file';
import { recordFileReport } from '@/core/reporting';

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  const url = new URL(req.url);
  const companyId = url.searchParams.get('companyId') ?? '';
  const periodKey = url.searchParams.get('periodKey') ?? '';
  if (!companyId || !/^\d{4}-\d{2}$/.test(periodKey)) {
    return new Response('companyId and periodKey (YYYY-MM) are required', { status: 400 });
  }
  try {
    const file = await cp39FileForBatch(s, { companyId, periodKey });
    await recordFileReport(s, {
      companyId,
      reportType: 'my.cp39-file',
      periodKey,
      rowCount: file.totals.mtdRecords,
      totals: { mtdCents: file.totals.mtdCents, cp38Cents: file.totals.cp38Cents },
      statutoryVersion: file.statutoryVersion,
    });
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/plain; charset=us-ascii',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Draft-Notice': 'DRAFT - not for submission until verified against e-PCB Plus',
      },
    });
  } catch (e) {
    const status = e instanceof Cp39NotReadyError ? 422 : 500;
    return new Response((e as Error).message, { status });
  }
}
