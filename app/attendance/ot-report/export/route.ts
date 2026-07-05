/**
 * Overtime report export (Overtime Rate Config, #e410da83). Admin-only; company-scoped via the active
 * company context. Per-employee OT amounts (RM) are compensation data, so the route MUST be admin-gated —
 * it mirrors app/analytics/export/route.ts (ADR-0047) for scoping, format dispatch, and the RFC-5987
 * Content-Disposition. Read-only — downloading mutates nothing.
 *
 * `format` selects the serializer: csv (default) | xlsx | pdf. Export-payload column headers stay ENGLISH
 * (resolved from constants, not getTranslations) to keep CSV byte-identical for external consumers and to
 * avoid the unenforceable present-but-English i18n gap (ADR-0047 §9).
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { overtimeReport, overtimeReportToReportData } from '@/core/reporting';
import { serializeReport, type ReportFormat } from '@/lib/report-export';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8-encoded `filename*`, so a
 *  localized/`q`-derived title can never break the header. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'csv';

  const monthRaw = url.searchParams.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : new Date().toISOString().slice(0, 7);

  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));

  try {
    const report = await overtimeReport(s, { month, companyIds: scopeIds });
    const data = overtimeReportToReportData(report);
    const { bytes, contentType, ext } = await serializeReport(data, format);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition(data.filename, ext),
      },
    });
  } catch (e) {
    console.error('overtime report export failed', e);
    return new Response('Could not generate the report — please try again.', { status: 500 });
  }
}
