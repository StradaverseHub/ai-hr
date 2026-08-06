/**
 * Transaction Detail Report download for one payroll run (e440991b point 6).
 *
 * GET /payroll/<batchId>/export?format=xlsx|csv|pdf — one row per employee on this run with every
 * earning, deduction, employer contribution and total, straight off each payslip's own stored snapshot
 * (see ./transaction-detail-report.ts for why that matters and what the columns are).
 *
 * SCOPE. `scopedAdmin()` fences the caller to their authorised companies, and the run itself is resolved
 * through `batchDetail`, which reads under RLS — a batch in another tenant returns null. The company is
 * then re-checked against `scopeIds` before anything is read, so a guessed batch id belonging to a
 * company outside the caller's scope 404s rather than exporting a payroll. Per-employee pay is the most
 * sensitive payload in the product; this route fails closed twice on purpose.
 *
 * Read-only: no writes, no DomainEvent. (The payment-summary export appends one because it marks money
 * as sent for payment — the state the unlock warning reads. This is a reconciliation read of figures the
 * screen already displays, so an event would be noise in the audit trail rather than a record of
 * anything.)
 */
import { scopedAdmin } from '@/lib/scope';
import { batchDetail } from '@/core/payroll';
import { listPayrollRegisterAcross } from '@/core/payroll-view';
import { serializeReport, type ReportFormat } from '@/lib/report-export';
import { rowsForRun, transactionDetailReport } from '../transaction-detail-report';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8 `filename*`, so a company name
 *  with non-ASCII characters can never break the header (mirrors the OT-report export). */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { batchId } = await params;

  const data = await batchDetail(s, batchId);
  // Not found, another tenant (RLS), or a company this admin is not scoped to — all one answer, so the
  // response cannot be used to probe which batch ids exist.
  if (!data || !scopeIds.includes(data.batch.companyId)) return new Response('Not found', { status: 404 });
  const { batch } = data;

  // A DRAFT run has no payslips at all, so there is nothing to reconcile and an empty workbook would
  // read as "this run pays nobody". Say so instead.
  if (batch.status === 'draft') {
    return new Response('This run has not been processed yet — there is nothing to export.', { status: 409 });
  }

  const url = new URL(req.url);
  const fmtRaw = url.searchParams.get('format');
  // xlsx by default: the reporter asked for Excel. csv/pdf stay reachable for anyone piping it onward.
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'xlsx';

  try {
    const [year, month] = batch.payPeriod.split('-').map(Number);
    const register = await listPayrollRegisterAcross(s, {
      companyIds: [batch.companyId],
      year,
      month,
      cycle: batch.runType,
    });
    const rows = rowsForRun(register, batch);
    const report = transactionDetailReport(
      { company: rows[0]?.company ?? batch.companyId, payPeriod: batch.payPeriod, runType: batch.runType, runSeq: batch.runSeq },
      rows,
    );
    const { bytes, contentType, ext } = await serializeReport(report, format);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition(report.filename, ext),
      },
    });
  } catch (e) {
    console.error('payroll transaction detail export failed', e);
    return new Response('Could not generate the report — please try again.', { status: 500 });
  }
}
