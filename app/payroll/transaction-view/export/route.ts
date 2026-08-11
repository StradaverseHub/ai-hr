/**
 * Individual Transaction History CSV export (feedback 7b2d4228). GET route that streams the dated one-off
 * transactions currently shown on /payroll/transaction-view?tab=individual, honouring the SAME
 * scope-guarded filters the page applies (out-of-scope companyId/employmentId is ignored — fail closed).
 * Admin/scope fenced via scopedAdmin(); the export appends a `payroll.individual-txn.exported` DomainEvent
 * (in core/payroll-view.ts), mirroring the payment-summary export precedent.
 */
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { exportIndividualTxnsCsv, INDIVIDUAL_TXN_STATUS_FILTERS } from '@/core/payroll-view';
import { TXN_KINDS } from '@/core/payroll-individual-txn';

// Same whitelist the screen applies (510f4bd1 added the derived 'reprocess'), imported rather than
// restated: the export exists to hand back exactly the rows on screen, and two lists that drift apart
// would hand back a different set — silently, because an unrecognised value DROPS the filter rather than
// erroring (core/payroll-view.ts cleanBatchStatus).
const TXN_STATUSES = INDIVIDUAL_TXN_STATUS_FILTERS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const rawCompany = url.searchParams.get('companyId');
  const companyId = rawCompany && scopeIds.includes(rawCompany) ? rawCompany : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;

  const rawEmployment = url.searchParams.get('employmentId');
  let employmentId: string | undefined;
  if (rawEmployment) {
    const employees = await listEmployees(s, scopeIds);
    employmentId = employees.some((e) => e.employmentId === rawEmployment) ? rawEmployment : undefined;
  }

  const year = intParam(url.searchParams.get('year'), 2000, 2100);
  const month = intParam(url.searchParams.get('month'), 1, 12);

  // The Individual History filters (feedback 7b2d4228). Whitelist/format-guarded — the core query also
  // re-coerces enums/dates, but validating here keeps a tampered param from ever reaching the service.
  const rawKind = url.searchParams.get('kind');
  const kind = rawKind && (TXN_KINDS as readonly string[]).includes(rawKind) ? rawKind : undefined;
  const departmentId = url.searchParams.get('departmentId') || undefined;
  const rawStatus = url.searchParams.get('txnStatus');
  const batchStatus = rawStatus && (TXN_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : undefined;
  const createdBy = url.searchParams.get('createdBy') || undefined;
  const rawFrom = url.searchParams.get('createdFrom');
  const createdFrom = rawFrom && ISO_DATE.test(rawFrom) ? rawFrom : undefined;
  const rawTo = url.searchParams.get('createdTo');
  const createdTo = rawTo && ISO_DATE.test(rawTo) ? rawTo : undefined;

  const file = await exportIndividualTxnsCsv(s, {
    companyIds,
    year,
    month,
    employmentId,
    kind,
    departmentId,
    batchStatus,
    createdBy,
    createdFrom,
    createdTo,
  });
  return new Response(file.content, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    },
  });
}
