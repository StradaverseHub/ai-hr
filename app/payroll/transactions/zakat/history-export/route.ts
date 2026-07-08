/**
 * Zakat "Applied in payroll" transaction-history CSV export (feedback d435673e). GET route that streams the
 * zakat deducted in each processed payroll run currently shown on the Zakat screen's history block, honouring
 * the SAME scope-guarded filters (h*-prefixed params) the page applies — an out-of-scope companyId/employmentId
 * is ignored (fail closed). Admin/scope fenced via scopedAdmin(); the export appends a `zakat.history.exported`
 * DomainEvent (in core/payroll-view.ts), mirroring the individual-txn / payment-summary export precedents.
 */
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { exportZakatTxnsCsv } from '@/core/payroll-view';

const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
// A payslip row only exists post-generation, so 'draft' is impossible in this history by construction.
const STATUSES = ['processed', 'closed'] as const;

/** Parse an optional positive-int query param within [min, max]; anything else ⇒ undefined. */
function intParam(v: string | null, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export async function GET(req: Request) {
  const { s, scopeIds } = await scopedAdmin();
  const url = new URL(req.url);

  // Mirror the page's scope-guarded param parsing: an out-of-scope companyId/employmentId is treated as
  // "no selection", so URL tampering can never cross the company fence.
  const rawCompany = url.searchParams.get('hCompanyId');
  const companyId = rawCompany && scopeIds.includes(rawCompany) ? rawCompany : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;

  const rawEmployment = url.searchParams.get('hEmploymentId');
  let employmentId: string | undefined;
  if (rawEmployment) {
    const employees = await listEmployees(s, scopeIds);
    employmentId = employees.some((e) => e.employmentId === rawEmployment) ? rawEmployment : undefined;
  }

  const year = intParam(url.searchParams.get('hYear'), 2000, 2100);
  const month = intParam(url.searchParams.get('hMonth'), 1, 12);
  const rawCycle = url.searchParams.get('hCycle');
  const cycle = rawCycle && (CYCLES as readonly string[]).includes(rawCycle) ? rawCycle : undefined;
  const rawStatus = url.searchParams.get('hStatus');
  const status = rawStatus && (STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : undefined;

  const file = await exportZakatTxnsCsv(s, { companyIds, year, month, employmentId, cycle, status });
  return new Response(file.content, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    },
  });
}
