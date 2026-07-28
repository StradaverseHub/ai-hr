/**
 * Advanced Search & Filter for Leave Management (feedback 0773bda9) — export the CURRENTLY FILTERED set.
 * Admin-gated download of leave records matching the same searchParams the /leave page uses, in CSV or
 * Excel (ADR-0047 serializers). Read-only: no DomainEvent is appended — downloading a report mutates
 * nothing (mirrors app/admin/claims/reimbursements/export/route.ts, which is likewise event-free).
 */
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listLeaveRequestsPage } from '@/core/read';
import { toCsvReport, toXlsxReport, type ReportData } from '@/lib/report-export';
import { durationLabel } from '@/lib/leave-duration';

const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

export async function GET(req: Request) {
  const { s: session, scopeIds } = await scopedSession();
  // Admin gate (precedent: reimbursements export route) — the filter/search/export surface is HR-admin only.
  if (!isAdmin(session)) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const sp = url.searchParams;
  const format = sp.get('format') === 'xlsx' ? 'xlsx' : 'csv';
  const one = (k: string) => sp.get(k)?.trim() || undefined;
  const statuses = sp.getAll('status').filter((s) => LEAVE_STATUSES.includes(s));
  const typeIds = sp.getAll('type').filter(Boolean);
  // Feedback 8ec63139: the org narrowings are multi-select on the page now, so the export must read them
  // the same way — a single get() would have exported a WIDER set than the screen showed.
  const many = (k: string) => sp.getAll(k).filter(Boolean);
  const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc';

  const t = await getTranslations('leave');
  // Explicit sane cap: an admin filtered set can be large but a single download must stay bounded.
  const { rows } = await listLeaveRequestsPage(session, {
    companyIds: scopeIds,
    q: one('q'),
    filterCompanyIds: many('company'),
    businessUnitIds: many('bu'),
    departmentIds: many('dept'),
    locationIds: many('loc'),
    employmentIds: many('emp'),
    durationTypes: many('duration'),
    leaveTypeIds: typeIds.length ? typeIds : undefined,
    statuses: statuses.length ? statuses : undefined,
    from: one('from'),
    to: one('to'),
    appliedFrom: one('appliedFrom'),
    appliedTo: one('appliedTo'),
    // Approval Information (feedback 0773bda9): pass the same approver filters the page uses so the export
    // matches exactly. pendingWith is whitelisted server-side in listLeaveRequestsPage.
    approvedBy: one('approvedBy'),
    pendingWith: one('pendingWith'),
    sort: one('sort'),
    dir,
    limit: 10_000,
    offset: 0,
  });

  const data: ReportData = {
    filename: `leave-requests-${new Date().toISOString().slice(0, 10)}`,
    title: t('requestsTitle'),
    columns: [
      t('colEmployee'),
      t('filters.employeeId'),
      t('filters.reference'),
      t('colType'),
      t('colStatus'),
      t('filters.dateFrom'),
      t('filters.dateTo'),
      t('colDays'),
      t('colApplied'),
      // Approval Information (feedback 0773bda9): the final decider on the exported row.
      t('filters.approvedBy'),
    ],
    rows: rows.map((r) => [
      r.employee,
      r.employeeCode ?? '',
      `#${r.id.slice(0, 8)}`,
      r.leaveType,
      t(`status.${r.status}`),
      r.startDate,
      r.endDate,
      `${Number(r.days)}${durationLabel(t, r.durationType, r.hours) ? ` ${durationLabel(t, r.durationType, r.hours)}` : ''}`,
      r.appliedOn ? new Date(r.appliedOn).toISOString().slice(0, 10) : '',
      r.decidedByName ?? '',
    ]),
  };

  const file = format === 'xlsx' ? toXlsxReport(data) : toCsvReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${data.filename}.${file.ext}"`,
    },
  });
}
