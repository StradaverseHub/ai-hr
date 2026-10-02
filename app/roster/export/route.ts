/**
 * Roster export (item 23390097) — "Export downloads what is on screen, exactly as it appears."
 *
 * It re-reads the SAME rosterWindowView the screen renders, with the same company / Business Group /
 * Department / Employee narrowing carried in the query string, so the file and the screen cannot
 * disagree.
 *
 * a57f0584 rev 2 — AND THE SAME WINDOW. The screen has three views now, so this route takes the window
 * off the query string through the SAME `resolveRosterWindow` the screen used: a week on screen exports
 * that week, not the month around it. It is the third caller of the one resolver, which is what stops
 * "Export" quietly meaning something different from the button it sits beside.
 *
 * AN OUT-OF-RANGE WINDOW IS A 400, NOT A 500. A query string is a public surface: `?from=2026-01-01
 * &to=2026-12-31` asks for 365 columns × every employee, and `assertRosterWindow` in core refuses it.
 * Refusing it HERE first turns that into a sentence the caller can act on rather than the route's own
 * "could not generate" catch-all.
 *
 * Access is the roster screen's own: the read is RLS-fenced to the employees the caller is responsible
 * for, and a company outside the caller's scope is refused outright.
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
import { RosterRangeError, rosterWindowView } from '@/core/roster';
import { serializeReport, type ReportFormat } from '@/lib/report-export';
import { ROSTER_TEMPLATE_ID_COLUMNS, resolveRosterCell, resolveRosterWindow, shiftCodeOf } from '@/lib/roster-month';
import {rosterTeamContext} from '../my-team-scope';
import {myTeamErrorResponse} from '@/app/manage/my-team/server';
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
  let team:Awaited<ReturnType<typeof rosterTeamContext>>;
  try{team=await rosterTeamContext(s,scopeIds,Object.fromEntries(url.searchParams));}catch(error){return myTeamErrorResponse(error);}
  const inScope = allowed.filter(c=>!team||team.scope.companyIds.includes(c.id)).filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));
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
  const resolved = resolveRosterWindow({
    view: url.searchParams.get('view'),
    month: url.searchParams.get('month'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    today: todayInKualaLumpur(),
  });
  // The SCREEN clamps and carries on, because it has somewhere to say so. A download has no banner, and
  // a file silently holding three months of a six-month request is the kind of wrong nobody checks.
  if (!resolved.ok) {
    return new Response(
      resolved.reason === 'too_wide'
        ? `That export asks for ${resolved.askedDays} days. Narrow the range and try again.`
        : 'The To date is before the From date.',
      { status: 400 },
    );
  }
  const win = team?resolveRosterWindow({view:team.query.view,month:team.scope.from.slice(0,7),from:team.scope.from,to:team.scope.to,today:todayInKualaLumpur()}).window:resolved.window;
  /** The file is named for what it holds: a month by its month, any other window by its two ends. */
  const stamp = win.kind === 'month' ? win.month : `${win.from}_${win.to}`;

  try {
    const view = await rosterWindowView(s, {
      companyIds,
      from: win.from,
      to: win.to,
      ...(url.searchParams.get('bu') ? { businessUnitId: url.searchParams.get('bu')! } : {}),
      ...(url.searchParams.get('dept') ? { departmentId: url.searchParams.get('dept')! } : {}),
      ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}),
      ...(team?{employmentIds:team.scope.employmentIds}:{}),
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
        filename: `roster-${stamp}`,
        title: `Shift Roster ${stamp}`,
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
      headers: { 'Content-Type': contentType, 'Content-Disposition': contentDisposition(`roster-${stamp}`, ext) },
    });
  } catch (e) {
    // The service guard is the backstop for a window this route did not resolve. It is the caller's
    // mistake, not the server's, so it keeps its 400 rather than being reported as a failure to generate.
    if (e instanceof RosterRangeError) return new Response(e.message, { status: 400 });
    console.error('roster export failed', e);
    return new Response('Could not generate the roster export — please try again.', { status: 500 });
  }
}
