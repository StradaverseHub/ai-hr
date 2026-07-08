/**
 * Custom report export (ADR-0074, c440b365). Admin-only; company-scoped via the active company context
 * (identical scope resolution to app/analytics/export/route.ts). Runs a SAVED report by id (GET) or an
 * ad-hoc spec (POST body — used for "export before save" from the builder) through the closed registry
 * runner, then serialises to the requested format: csv | xlsx | pdf | docx.
 *
 * Read-only — downloading mutates nothing. Column headers stay ENGLISH (from the registry field labels)
 * for stable external consumption (ADR-0047 §9).
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { ReportAccessError, runCustomReport } from '@/core/custom-reports';
import { validateReportSpec } from '@/core/report-registry';
import { serializeReport, type ReportData, type ReportFormat } from '@/lib/report-export';
import type { CustomReportSpec } from '@/db/schema';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf', 'docx'];

function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function serve(data: ReportData, format: ReportFormat): Promise<Response> {
  const { bytes, contentType, ext } = await serializeReport(data, format);
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': contentType, 'Content-Disposition': contentDisposition(data.filename, ext) },
  });
}

function pickFormat(v: string | null): ReportFormat {
  return FORMATS.includes(v as ReportFormat) ? (v as ReportFormat) : 'csv';
}

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return new Response('Missing report id', { status: 400 });
  const format = pickFormat(url.searchParams.get('format'));
  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  try {
    // Downloading a saved report is the reporter's 'export' verb — enforced against the report's grid.
    const data = await runCustomReport(s, scopeIds, { id, verb: 'export' });
    return serve(data, format);
  } catch (e) {
    if (e instanceof ReportAccessError) return new Response('Forbidden', { status: 403 });
    console.error('custom report export failed', e);
    return new Response('Could not generate the report — please try again.', { status: 500 });
  }
}

export async function POST(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  let body: { spec?: CustomReportSpec; format?: string };
  try {
    body = (await req.json()) as { spec?: CustomReportSpec; format?: string };
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const spec = body.spec;
  if (!spec || !validateReportSpec(spec).ok) return new Response('Invalid report spec', { status: 400 });
  const format = pickFormat(body.format ?? null);
  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  try {
    const data = await runCustomReport(s, scopeIds, { spec });
    return serve(data, format);
  } catch (e) {
    console.error('custom report export failed', e);
    return new Response('Could not generate the report — please try again.', { status: 500 });
  }
}
