/**
 * SOCSO + EIS combined contribution textfile download (PERKESO ASSIST, v2.0 with SKBBK). Byte layout:
 * ⚠️ r296 — THE BYTES COME FROM `lib/perkeso-socso-file.ts`, THE SAME WRITER THE BORANG 8A REVIEW SCREEN
 * DOWNLOADS FROM, and the two screens now hand over identical files for the same month. Which revision
 * of PERKESO's format is written (v1.0 of 22 Jul 2022, or v2.0 of 13 Feb 2026 with the SKBBK column) is
 * decided by `perkesoLayoutForPeriod` from the CONTRIBUTION MONTH against the 1 October 2026 cutover, and
 * by nothing on this route. `localization/my/socso-eis-file.ts` is now the READ only.
 *
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
      // r296 — SPREAD, NOT SPELLED OUT, and `skbbkCents` is absent unless the file actually has a SKBBK
      // box. A `skbbkCents: 0` recorded against a v1.0 file would be a durable assertion that no SKBBK
      // was owed for that month, when in fact the layout PERKESO accepts has nowhere to put it; that
      // money is recorded as `skbbkNotCarriedCents` instead. See SocsoEisFile['totals'].
      totals: {
        socsoCents: file.totals.socsoCents,
        eisCents: file.totals.eisCents,
        salaryCents: file.totals.salaryCents,
        ...(file.totals.skbbkCents === undefined ? {} : { skbbkCents: file.totals.skbbkCents }),
        ...(file.totals.skbbkNotCarriedCents === undefined
          ? {}
          : { skbbkNotCarriedCents: file.totals.skbbkNotCarriedCents }),
      },
      statutoryVersion: file.statutoryVersion,
      // ADR-0077 slice 9 — a filing deadline does not pause for a billing dispute. Without this the
      // artefact write fails on a suspended tenant and the generic catch below turns it into a 500,
      // leaving the customer unable to file at all.
      agency: 'PERKESO',
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
