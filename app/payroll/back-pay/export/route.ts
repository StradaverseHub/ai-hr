/**
 * Back Pay verification export (2ef69d1e) — csv / xlsx / pdf, for management sign-off before anything
 * is paid. Admin-only: an arrears line names an employee and a salary difference, which is compensation
 * data. Route shape copied from app/attendance/ot-report/export/route.ts (Node runtime for pdf-lib, the
 * RFC 5987 disposition, admin gate); serialisation is lib/report-export.ts, unchanged.
 *
 * Read-only — downloading mutates nothing, and in particular it does NOT mark the run verified. That is
 * a deliberate separate click: "I downloaded the sheet" and "I have checked the sheet" are not the same
 * statement, and only the second one should appear in the audit trail.
 *
 * Column headers stay ENGLISH (resolved from constants, not getTranslations) to keep the CSV
 * byte-identical for external consumers — the ADR-0047 §9 convention every other export here follows.
 *
 * THE SIGN IS CARRIED THROUGH. A backdated reduction exports as a negative number, not an absolute
 * value with a note somewhere: the sheet a manager signs has to say which way the money goes.
 *
 * ONE VERIFIED WRINKLE, LEFT ALONE DELIBERATELY: in CSV a negative comes out as `'-20.00`. That
 * apostrophe is `csvSafeCell` (lib/csv.ts), the repo-wide formula-injection guard every CSV export
 * rides — a cell starting with `-` is a spreadsheet formula vector. Two ways to make it prettier were
 * both rejected: weakening the guard is never acceptable, and switching to accounting parentheses
 * `(20.00)` would stop `isNumeric` recognising the cell, so XLSX would lose the `x:num` typing and the
 * figure would arrive in Excel as TEXT rather than a real negative number. The true signed value is
 * kept, XLSX and PDF show it plainly, and CSV shows it safely.
 */
import { isAdmin } from '@/lib/authz';
import { getSession } from '@/lib/session';
import { backPayRunDetail } from '@/core/back-pay';
import { serializeReport, type ReportData, type ReportFormat } from '@/lib/report-export';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8-encoded `filename*`. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const num = (n: number) => n.toFixed(2);

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const runId = url.searchParams.get('run') ?? '';
  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'csv';
  if (!runId) return new Response('Missing run', { status: 400 });

  try {
    const detail = await backPayRunDetail(s, runId);
    if (!detail) return new Response('Not found', { status: 404 });

    // One column per affected month, plus the original/reworked pair the plan promises ("the original
    // month, the reworked month, the difference and the total"). Per-month originals and reworked
    // figures are carried as a THIRD block rather than tripling every month column, so the sheet stays
    // readable at a dozen months.
    const columns = [
      'Employee Code',
      'Employee',
      'Pay Item',
      ...detail.periods.map((p) => `${p} Difference`),
      'Total',
      'Needs Review',
      'Reason',
      'Original (sum)',
      'Reworked (sum)',
    ];
    const rows: (string | number | null)[][] = detail.rows.map((r) => {
      const originals = detail.periods.reduce((sum, p) => sum + (r.byPeriod[p]?.old ?? 0), 0);
      const reworked = detail.periods.reduce((sum, p) => sum + (r.byPeriod[p]?.new ?? 0), 0);
      return [
        r.employeeCode ?? '',
        r.employeeName,
        r.payItemName,
        ...detail.periods.map((p) => (r.byPeriod[p] ? (r.needsReview ? '' : num(r.byPeriod[p]!.diff)) : '')),
        r.needsReview ? '' : num(r.total),
        r.needsReview ? 'Yes' : 'No',
        r.reviewReason ?? '',
        num(originals),
        r.needsReview ? '' : num(reworked),
      ];
    });
    // The signed grand total, on its own row — what the sign-off is actually for.
    rows.push([
      '',
      'TOTAL',
      '',
      ...detail.periods.map(() => ''),
      num(detail.total),
      '',
      '',
      '',
      '',
    ]);

    const data: ReportData = {
      filename: `back-pay-${detail.run.targetPayPeriod}-${detail.run.id.slice(0, 8)}`,
      title: `Back Pay (Arrears) — ${detail.run.companyName} — paid in ${detail.run.targetPayPeriod}`,
      columns,
      rows,
    };
    const { bytes, contentType, ext } = await serializeReport(data, format);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition(data.filename, ext),
      },
    });
  } catch (e) {
    console.error('back pay export failed', e);
    return new Response('Could not generate the report — please try again.', { status: 500 });
  }
}
