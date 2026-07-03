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
  analyticsDateRange,
  carryForwardReport,
  changeJobTransactions,
  masterDataExport,
  newHires,
  parseAnalyticsFilters,
  parseReportYear,
  terminations,
  type ReportFilter,
} from '@/core/analytics';
import { serializeReport, type ReportData, type ReportFormat } from '@/lib/report-export';

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
  const report = url.searchParams.get('report') ?? 'master-data';
  const fmtRaw = url.searchParams.get('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'csv';

  // Single filter source of truth (shared with the /analytics page) so an exported report can never
  // disagree with the on-screen chart for the same filter set — identical date-default + parse logic.
  const get = (k: string) => url.searchParams.get(k);
  const { from, to } = analyticsDateRange(get);
  const today = to;
  // The legacy CSV/XLSX/PDF reports take a ReportFilter (department + q); derive it from the shared parse.
  const parsed = parseAnalyticsFilters(get);
  const filter: ReportFilter = { departmentId: parsed.departmentId, q: parsed.q };

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
    } else if (report === 'carry-forward') {
      const year = parseReportYear(get);
      const companyId = url.searchParams.get('companyId') ?? undefined;
      const rows = await carryForwardReport(s, scopeIds, { year, filter, companyId });
      const reasonLabel = (code: 'cap' | 'expiry') =>
        code === 'cap' ? 'Exceeded carry-forward limit' : 'Auto forfeit due to expiry';
      data = {
        title: 'Carry-forward & forfeiture',
        filename: `carry-forward_${year}`,
        columns: ['Employee', 'Company', 'Department', 'Leave year', 'Carried forward', 'Expiry date', 'Forfeited at open', 'Forfeited at expiry', 'Reason'],
        rows: rows.map((r) => [
          r.employeeName,
          r.company,
          r.department ?? '',
          r.leaveYear,
          r.carried,
          r.carryForwardExpiryDate ?? '',
          r.forfeitedAtOpen,
          r.forfeitedAtExpiry,
          r.reasonCodes.map(reasonLabel).join('; '),
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
