/**
 * CP39 e-Data PCB text-file download (Layer-B DRAFT — not for submission until verified against
 * the live e-PCB Plus portal). Byte layout: LHDN MTD spec Exhibit 4 (REPORT-FORMATS.md §1).
 * Each download records an append-only statutory_report artefact + domain event.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { cp39FileForBatch, Cp39NotReadyError } from '@/localization/my/cp39-file';
import { recordFileReport } from '@/core/reporting';
import { parseRunSelection } from '@/lib/payroll-run-selection';

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  const url = new URL(req.url);
  const companyId = url.searchParams.get('companyId') ?? '';
  const periodKey = url.searchParams.get('periodKey') ?? '';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(companyId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) {
    return new Response('A valid companyId (uuid) and periodKey (YYYY-MM) are required', { status: 400 });
  }
  // r409 (item 79f3f64d) — THE PAYROLL CYCLES THE CP39 REVIEW WAS OPENED FOR. The review screen's e-Data
  // button carries the criteria step's `run` values, and this route used to drop them and build the whole
  // month — a filtered review downloading an unfiltered upload file. `cp39FileForBatch` has honoured
  // `runSeqs` since r372 (Payment Submission); absent ⇒ undefined ⇒ the whole month, as every older link
  // is. An invalid selection is REFUSED, never dropped, through the one shared parser.
  const selection = parseRunSelection(url.searchParams);
  if (!selection.ok) return new Response(selection.reason, { status: 422 });
  try {
    const file = await cp39FileForBatch(s, { companyId, periodKey, runSeqs: selection.runSeqs });
    await recordFileReport(s, {
      companyId,
      reportType: 'my.cp39-file',
      periodKey,
      rowCount: file.totals.mtdRecords,
      totals: { mtdCents: file.totals.mtdCents, cp38Cents: file.totals.cp38Cents },
      statutoryVersion: file.statutoryVersion,
      // ADR-0077 slice 9 — a filing deadline does not pause for a billing dispute. Without this the
      // artefact write fails on a suspended tenant and the generic catch below turns it into a 500,
      // leaving the customer unable to file at all.
      agency: 'LHDN',
    });
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/plain; charset=us-ascii',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Draft-Notice': 'DRAFT - not for submission until verified against e-PCB Plus',
      },
    });
  } catch (e) {
    // Surface the readiness reason (safe, actionable); never echo a raw driver error to the client.
    if (e instanceof Cp39NotReadyError) return new Response(e.message, { status: 422 });
    console.error('cp39-file generation failed', e);
    return new Response('Could not generate the CP39 file — please try again.', { status: 500 });
  }
}
