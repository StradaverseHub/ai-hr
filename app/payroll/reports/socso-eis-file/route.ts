/**
 * SOCSO + EIS combined contribution textfile download (PERKESO ASSIST, v2.0 with SKBBK). Byte layout:
 * PERKESO "Combine SOCSO + EIS Contribution Text File Format" v2.0 (localization/my/socso-eis-file.ts).
 * Each download records an append-only statutory_report artefact + domain event.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { socsoEisFileForBatch, SocsoEisNotReadyError } from '@/localization/my/socso-eis-file';
import { recordFileReport } from '@/core/reporting';

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
  try {
    const file = await socsoEisFileForBatch(s, { companyId, periodKey });
    await recordFileReport(s, {
      companyId,
      reportType: 'my.socso-eis-file',
      periodKey,
      rowCount: file.totals.records,
      totals: {
        socsoCents: file.totals.socsoCents,
        eisCents: file.totals.eisCents,
        skbbkCents: file.totals.skbbkCents,
        salaryCents: file.totals.salaryCents,
      },
      statutoryVersion: file.statutoryVersion,
    });
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/plain; charset=us-ascii',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Draft-Notice': 'Confirm filename/encoding/line-ending on first PERKESO ASSIST upload',
      },
    });
  } catch (e) {
    if (e instanceof SocsoEisNotReadyError) return new Response(e.message, { status: 422 });
    console.error('socso-eis-file generation failed', e);
    return new Response('Could not generate the SOCSO+EIS file — please try again.', { status: 500 });
  }
}
