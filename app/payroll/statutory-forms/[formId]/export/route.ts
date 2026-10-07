/**
 * Statutory form export — CSV / XLSX / PDF for any form on the Statutory Forms shelf (6babf4f6).
 *
 * ONE ROUTE FOR EVERY FORM, because the shape is the same for every form: a `ReportResult` is columns,
 * rows and totals, and `lib/report-export.ts` already serialises exactly that (the same three formats
 * five existing export routes use). The alternative — a route per form — is the flat-list problem again,
 * one directory down. A newly built form gets its downloads for free.
 *
 * Route shape copied from app/payroll/back-pay/export/route.ts: Node runtime for pdf-lib, `scopedAdmin`
 * rather than `isAdmin`, and the RFC 5987 disposition.
 *
 * THE SCOPE CHECK IS THE POINT. `isAdmin` is true for an hr_admin grant on ANY company, so a guessed
 * `companyId` would export another company's per-employee statutory numbers — names, ICs, tax numbers and
 * contributions, the most sensitive payload in the product. This fails closed twice: the session must be
 * an admin, AND the company must be one they are scoped to. An unknown form id, an unscoped company and a
 * company that does not exist are ALL one 404, so the URL cannot be used to enumerate any of them.
 *
 * COLUMN HEADERS COME FROM THE PACK, NOT FROM `getTranslations` — the ADR-0047 §9 convention every export
 * here follows, so the CSV stays byte-stable for whoever consumes it downstream. `ReportResult` columns
 * already carry their labels.
 *
 * NO ARTEFACT IS RECORDED. Downloading a spreadsheet is not filing; "I generated the form" is a separate,
 * deliberate click (Record generation) and only that one should appear in the audit trail. The two
 * Layer-B AGENCY files (e-CP39, PERKESO ASSIST) do record, because those bytes are the submission itself —
 * they keep their own routes, unchanged.
 */
import { scopedAdmin } from '@/lib/scope';
import { listReports, reportPreview } from '@/core/reporting';
import { serializeReport, type ReportData, type ReportFormat } from '@/lib/report-export';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8-encoded `filename*`. */
function contentDisposition(base: string, ext: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ formId: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { formId } = await params;

  const url = new URL(req.url);
  const companyId = url.searchParams.get('companyId') ?? '';
  const periodKey = url.searchParams.get('periodKey') ?? '';
  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'csv';

  if (!UUID.test(companyId)) return new Response('A valid companyId (uuid) is required', { status: 400 });
  // Not scoped to this company: the same 404 an unknown form gets, never a 403 that confirms it exists.
  if (!scopeIds.includes(companyId)) return new Response('Not found', { status: 404 });

  try {
    // Resolved against THIS COMPANY's jurisdiction, so a form belonging to another pack 404s rather than
    // generating an empty sheet under its name.
    const def = (await listReports(s, companyId)).find((r) => r.id === formId);
    if (!def) return new Response('Not found', { status: 404 });
    // A monthly form takes YYYY-MM, an annual one takes YYYY. Validated here rather than passed through,
    // because the generators read the period as a literal batch key and a malformed one silently produces
    // an empty return that looks like "no payroll this month".
    const periodOk = def.periodKind === 'year' ? /^\d{4}$/.test(periodKey) : /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey);
    if (!periodOk) return new Response('A valid periodKey is required', { status: 400 });

    const result = await reportPreview(s, { companyId, reportId: formId, periodKey });
    const data: ReportData = {
      filename: `${formId.replace(/[^a-zA-Z0-9._-]/g, '_')}_${periodKey}`,
      title: `${def.label} — ${periodKey}`,
      columns: result.columns.map((c) => c.label),
      rows: result.rows.map((row) => result.columns.map((c) => row[c.key] ?? '')),
      layout: {
        // Numeric columns right-aligned in every format, from the pack's own `numeric` flag — the one
        // piece of adapter work `ReportResult` → `ReportData` needs.
        align: result.columns.map((c) => (c.numeric ? 'right' : 'left')),
        // Employee name is the column you read down; keep it on screen when the sheet is wide.
        freeze: 1,
      },
    };
    const { bytes, contentType, ext } = await serializeReport(data, format);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        // r409 (item 79f3f64d) — THE PREVIEW IS THIS ROUTE, ASKED TO SHOW RATHER THAN SAVE (the Borang A
        // route's r407 rule). Form E / CP8D's viewer frames `…&format=pdf&disposition=inline`: the same
        // read, the same serializer, the same bytes — only this header differs. Inline for a PDF only; any
        // other value, or any other format, saves.
        'Content-Disposition': contentDisposition(
          data.filename,
          ext,
          format === 'pdf' && url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment',
        ),
      },
    });
  } catch (e) {
    console.error('statutory form export failed', e);
    return new Response('Could not generate the form — please try again.', { status: 500 });
  }
}
