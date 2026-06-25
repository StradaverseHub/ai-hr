/**
 * Analytics report export (Wave 4C → ADR-0047). Admin-only; company-scoped via the active company
 * context. Compensation columns appear only for the master-data report with comp=1 (admin-gated in the
 * read layer, Wave 1 #5). Read-only — downloading mutates nothing.
 *
 * `format` selects the serializer: csv (default) | xlsx | pdf. Export-payload column headers stay
 * ENGLISH (resolved from constants, not getTranslations) to keep CSV byte-identical for external
 * consumers and to avoid the unenforceable present-but-English i18n gap (ADR-0047 §9).
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import {
  changeJobTransactions,
  masterDataExport,
  newHires,
  terminations,
  type ReportFilter,
} from '@/core/analytics';
import { serializeReport, type ReportData, type ReportFormat } from '@/lib/report-export';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const report = url.searchParams.get('report') ?? 'master-data';
  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'csv';

  const today = new Date().toISOString().slice(0, 10);
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from')! : `${today.slice(0, 4)}-01-01`;
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to')! : today;

  // Scoping filter (ADR-0047): departmentId must be uuid-shaped (else ignored); q clamped to 100 chars.
  const deptRaw = url.searchParams.get('departmentId');
  const qRaw = url.searchParams.get('q');
  const filter: ReportFilter = {
    departmentId: deptRaw && UUID.test(deptRaw) ? deptRaw : undefined,
    q: qRaw ? qRaw.slice(0, 100) : undefined,
  };

  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));

  let data: ReportData;

  try {
    if (report === 'new-hires') {
      const rows = await newHires(s, scopeIds, { from, to, filter });
      data = {
        title: 'New hires',
        filename: `new-hires_${from}_${to}`,
        columns: ['Name', 'Company', 'Department', 'Position', 'Hired on'],
        rows: rows.map((r) => [r.name, r.company, r.department, r.position, r.hiredOn]),
      };
    } else if (report === 'terminations') {
      const rows = await terminations(s, scopeIds, { from, to, filter });
      data = {
        title: 'Terminations',
        filename: `terminations_${from}_${to}`,
        columns: ['Name', 'Company', 'Department', 'Terminated on', 'Type', 'Reason'],
        rows: rows.map((r) => [
          r.name,
          r.company,
          r.department,
          r.terminatedOn,
          r.terminationType,
          r.terminationReason,
        ]),
      };
    } else if (report === 'change-jobs') {
      const rows = await changeJobTransactions(s, scopeIds, { from, to, filter });
      data = {
        title: 'Change job transactions',
        filename: `change-jobs_${from}_${to}`,
        columns: ['Name', 'Company', 'From department', 'To department', 'From position', 'To position', 'Effective on'],
        rows: rows.map((r) => [
          r.name,
          r.company,
          r.fromDepartment,
          r.toDepartment,
          r.fromPosition,
          r.toPosition,
          r.effectiveOn,
        ]),
      };
    } else {
      // master-data
      const comp = url.searchParams.get('comp') === '1';
      const includeTerminated = url.searchParams.get('all') === '1';
      const rows = await masterDataExport(s, scopeIds, { includeComp: comp, includeTerminated, filter });
      // Comp columns derive from the SAME `comp` flag on both the header and every row (ADR-0047 §4.5)
      // so the neutral {columns, rows} never goes ragged.
      const columns = [
        'Employee code', 'Name', 'Email', 'Company', 'Department', 'Position', 'Status', 'Employment type', 'Hired on', 'Terminated on',
        ...(comp ? ['Basic salary', 'Monthly allowance', 'Currency'] : []),
      ];
      data = {
        title: 'Master data',
        filename: `master-data_${today}`,
        columns,
        rows: rows.map((r) => [
          r.employeeCode, r.name, r.email, r.company, r.department, r.position, r.status, r.employmentType, r.hiredOn, r.terminatedOn,
          ...(comp ? [r.basicSalary ?? '', r.monthlyAllowance ?? '', r.currency ?? ''] : []),
        ]),
      };
    }

    const { bytes, contentType, ext } = await serializeReport(data, format);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition(data.filename, ext),
      },
    });
  } catch (e) {
    console.error('analytics export failed', e);
    return new Response('Could not generate the report — please try again.', { status: 500 });
  }
}
