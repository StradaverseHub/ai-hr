/**
 * 7709ffd1 (r369) — MY REQUEST, EXPORTED. "It downloads exactly what you are looking at."
 *
 * ── WHOSE ROWS, AND WHY NOTHING ON THE QUERY STRING DECIDES ─────────────────────────────────────────
 * The employment is resolved SERVER-SIDE from the session (`myEmployment`), and no employment id is read
 * off the query string at all — not validated, not compared, not read. A download of somebody else's
 * attendance requests is the one failure this route could have that nobody would notice, so the identity
 * is simply never an input. `myAttendanceCorrections` is RLS-fenced on top of that.
 *
 * ── ONE CEILING, ONE WHITELIST, ONE DATE EXPRESSION — SHARED WITH THE SCREEN ─────────────────────────
 *  · The status comes through the SAME `parseRequestStatus` the pills derive from (../rows.ts), so the file
 *    and the tab cannot narrow differently. A second copy of that three-line derivation here is exactly the
 *    defect the roster export's own header warns about.
 *  · The row ceiling is the kernel's published `MY_ATTENDANCE_REQUEST_ROW_CEILING`, read through the same
 *    probe-and-refuse helper the screen uses. Past it this route answers a SENTENCE, not a short workbook:
 *    a clamped export is a file that looks complete and is not, and unlike a screen a file has no banner to
 *    say so. The screen refuses at the same point, so the link is not even offered.
 *  · Submitted is the MALAYSIAN calendar day of `created_at`, through `todayInKualaLumpur` — the same
 *    expression `submittedOn` in ../page.tsx resolves. Those two renditions are pinned against each other
 *    in test/7709ffd1-my-request.test.ts precisely because a UTC slice here and a Malaysian day there (or
 *    the reverse) would print two different days for one request.
 *
 * ── FORMAT AND NAME ─────────────────────────────────────────────────────────────────────────────────
 * `serializeReport`'s xlsx writer is the product's one zero-dependency SpreadsheetML workbook, so it
 * returns ext `xls` and `application/vnd.ms-excel` (lib/report-export.ts). Nothing here promises `.xlsx`;
 * the file opens in Excel exactly as every other download in this product does. The base name is
 * MyRequest_<employeeCode>_<YYYYMMDD> stamped from `todayInKualaLumpur()`, never a UTC slice.
 *
 * COLUMN HEADERS STAY ENGLISH (ADR-0047 §9) — the payload is read by external tools. The VALUES that name
 * a state do not: Type resolves through KIND_LABEL and Status through `statusLabel`, so a withdrawn row
 * reads "Withdrawn" in the file exactly as it does on screen (r363).
 */
import { getSession } from '@/lib/session';
import { getTranslations } from 'next-intl/server';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { MY_ATTENDANCE_REQUEST_ROW_CEILING, myAttendanceCorrections } from '@/packs/attendance/service';
import { serializeReport, type ReportFormat } from '@/lib/report-export';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { KIND_LABEL, askedFor, statusLabel } from '../../request-ui';
import { parseRequestStatus, requestRowsProbeLimit, resolveRequestRows } from '../rows';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime (serializeReport dispatches to it)

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];

/** Export-payload headers, ENGLISH and in the screen's own column order (ADR-0047 §9). */
const COLUMNS = ['Date', 'Type', 'What was asked for', 'Reason', 'Remark', 'Submitted', 'Goes to', 'Status'] as const;

/** Relative column weights. "What was asked for" carries the most words on screen and in the file. */
const WIDTHS = [10, 12, 26, 18, 14, 10, 14, 10];

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8-encoded `filename*`. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`. Day-first, which is how every date in this product reads. */
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export async function GET(req: Request) {
  const s = await getSession();
  const me = await myEmployment(s);
  // No active employment is not an error in the log — there is simply nothing of theirs to export.
  if (!me) return new Response('Forbidden', { status: 403 });

  const t = await getTranslations('me');
  const url = new URL(req.url);
  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'xlsx';
  const status = parseRequestStatus(url.searchParams.get('status'));

  try {
    const [fetched, lines] = await Promise.all([
      myAttendanceCorrections(s, me.employmentId, {
        ...(status ? { status } : {}),
        limit: requestRowsProbeLimit(MY_ATTENDANCE_REQUEST_ROW_CEILING),
      }),
      reportingLinesFor(s, me.employmentId),
    ]);
    const { rows: shown, refusal } = resolveRequestRows(fetched, MY_ATTENDANCE_REQUEST_ROW_CEILING);
    // REFUSED, NOT CLAMPED. 400 rather than 500: it is not a failure to generate, and the caller has a way
    // out (pick a status). Same shape and same status code as the roster export's too-wide window.
    if (refusal === 'too_many') {
      return new Response(t('maTooManyRequests', { ceiling: MY_ATTENDANCE_REQUEST_ROW_CEILING }), { status: 400 });
    }
    if (shown.length === 0) return new Response(t('maExportNone'), { status: 404 });

    const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');
    const isOvertime = (r: (typeof shown)[number]) => r.proposedCheckIn == null && r.requestedOtMinutes != null;

    const rows = shown.map((r) => [
      dmy(r.attendanceDate),
      t(KIND_LABEL[r.requestKind ?? (isOvertime(r) ? 'self_overtime' : 'other')]),
      askedFor(r, t),
      r.reason ?? '',
      r.remark ?? '',
      dmy(todayInKualaLumpur(r.createdAt)),
      // The screen prints this only on a PENDING row, because on a decided one it asserts the request is
      // still with somebody (see app/attendance/request-status/page.tsx A3). The file follows the screen.
      r.status === 'pending' ? approver : '',
      statusLabel(r.status, t, isOvertime(r)),
    ]);

    const stamp = todayInKualaLumpur().replace(/-/g, '');
    const base = `MyRequest_${me.employeeCode ?? me.employmentId}_${stamp}`;
    const { bytes, contentType, ext } = await serializeReport(
      {
        filename: base,
        title: t('maRequestsTitle'),
        columns: [...COLUMNS],
        rows,
        layout: {
          // Who this is, which tab produced it, and when — so a file sent on can still answer all three.
          header: [me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · '),
          subtitle: status ? statusLabel(status, t, false) : t('maFilterAll'),
          description: `${t('maColSubmitted')}: ${dmy(todayInKualaLumpur())}`,
          orientation: 'landscape',
          widths: WIDTHS,
          freeze: 1, // the header row stays put while the list scrolls
        },
      },
      format,
    );
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': contentType, 'Content-Disposition': contentDisposition(base, ext) },
    });
  } catch (e) {
    console.error('my request export failed', e);
    return new Response('Could not generate the export — please try again.', { status: 500 });
  }
}
