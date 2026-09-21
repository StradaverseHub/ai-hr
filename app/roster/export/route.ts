/**
 * Monthly roster export (item 23390097) — "Export downloads the month exactly as it appears on screen."
 *
 * It re-reads the SAME rosterMonthView the screen renders, with the same company / Business Group /
 * Department / Employee narrowing carried in the query string, so the file and the screen cannot
 * disagree. Access is the roster screen's own: the read is RLS-fenced to the employees the caller is
 * responsible for, and a company outside the caller's scope is refused outright.
 *
 * HOW A GHOSTED DAY IS PRINTED, and why it matters. On screen a date nobody rostered shows the person's
 * usual shift in grey. Grey does not survive into a spreadsheet, so it is printed as `(CODE)` — and the
 * uploader treats a bracketed cell as "leave this date exactly as it is". That single convention is what
 * makes an exported month safe to send straight back up: without it, re-uploading the export would turn
 * every implied day into a hard-rostered one.
 *
 * `layout.freeze = 4` keeps Employee No / Name / Department / Occupation on screen while the dates
 * scroll, which is the whole point of the grid.
 */
import { getSession } from '@/lib/session';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { rosterMonthView } from '@/core/roster';
import { serializeReport, type ReportFormat } from '@/lib/report-export';
import { ROSTER_TEMPLATE_ID_COLUMNS, isMonthParam, monthOf, resolveRosterCell, shiftCodeOf } from '@/lib/roster-month';
import { todayInKualaLumpur } from '@/lib/hr-date';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8-encoded `filename*`. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request) {
  const s = await getSession();
  const url = new URL(req.url);

  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  const inScope = allowed.filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));
  if (inScope.length === 0) return new Response('Forbidden', { status: 403 });
  const asked = url.searchParams.get('companyId');
  /**
   * a57f0584 — the export must span the same companies the screen does, or the file disagrees with what
   * was on screen when it was asked for. Unchosen means EVERY in-scope company now, not `inScope[0]`.
   * `inScope` is already the authorised set, so this widens what is asked for, never what is permitted.
   */
  const chosen = inScope.find((c) => c.id === asked) ?? null;
  const companyIds = chosen ? [chosen.id] : inScope.map((c) => c.id);
  /** The subtitle names one company only when the file IS one company's. */
  const subtitle = chosen ? chosen.name : null;

  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'xlsx';
  const monthRaw = url.searchParams.get('month') ?? '';
  const month = isMonthParam(monthRaw) ? monthRaw : monthOf(todayInKualaLumpur());

  try {
    const view = await rosterMonthView(s, {
      companyIds,
      month,
      ...(url.searchParams.get('bu') ? { businessUnitId: url.searchParams.get('bu')! } : {}),
      ...(url.searchParams.get('dept') ? { departmentId: url.searchParams.get('dept')! } : {}),
      ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}),
    });

    const codeById = new Map(view.shifts.map((sh) => [sh.id, shiftCodeOf(sh)]));
    // A usual shift can be one the shift LIST does not carry (an archived template still set as somebody's
    // default), so the usual-shift names read back from the view rather than the live list.
    const usualCode = (id: string) => codeById.get(id) ?? shiftCodeOf(view.usualNames[id]);

    // Export-payload headers stay ENGLISH (ADR-0047 §9) — the file is read by external tools. Shared
    // with the upload template, so the file you download and the file the analyzer accepts are one shape.
    const columns = [...ROSTER_TEMPLATE_ID_COLUMNS, ...view.dates];
    const rows = view.employees.map((e) => [
      e.code ?? '',
      e.name,
      e.department ?? '',
      e.occupation ?? '',
      ...view.dates.map((iso) => {
        const cell = resolveRosterCell(iso, view.cells[`${e.employmentId}|${iso}`] ?? null, view.usual[e.employmentId] ?? null);
        switch (cell.kind) {
          case 'shift':
            return codeById.get(cell.shiftId) ?? '';
          case 'rest':
            return 'RD';
          case 'usual':
            return `(${usualCode(cell.shiftId)})`;
          case 'off':
            return 'OFF';
          default:
            return '';
        }
      }),
    ]);

    const { bytes, contentType, ext } = await serializeReport(
      {
        filename: `roster-${month}`,
        title: `Shift Roster ${month}`,
        columns,
        rows,
        layout: {
          ...(subtitle ? { subtitle } : {}),
          description: 'A code in brackets is the employee\u2019s usual shift, not a rostered day. RD = rest day, OFF = not scheduled.',
          orientation: 'landscape',
          freeze: 4,
        },
      },
      format,
    );
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': contentType, 'Content-Disposition': contentDisposition(`roster-${month}`, ext) },
    });
  } catch (e) {
    console.error('roster export failed', e);
    return new Response('Could not generate the roster export — please try again.', { status: 500 });
  }
}
