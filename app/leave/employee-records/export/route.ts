/**
 * Employee Leave Record export (feedback 953be4b0) — the currently filtered transaction list, CSV or Excel.
 *
 * Admin-gated and read-only (no DomainEvent — downloading a report mutates nothing), and it reads through
 * the same `listLeaveRequestsPage` the screen does with the same params, so the file matches the screen.
 * The document itself is never exported — only whether one exists — so the export cannot become a way
 * around the per-request attachment authorization.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listEmployees, listLeaveRequestsPage } from '@/core/read';
import { toCsvReport, toXlsxReport, type ReportData } from '@/lib/report-export';
import { pickInquiryEmployee, sortInquiryEmployees } from '@/lib/leave-inquiry';
import { durationLabel } from '@/lib/leave-duration';
import { todayInKualaLumpur } from '@/lib/hr-date';

const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

export async function GET(req: Request) {
  const { s: session, scopeIds } = await scopedSession();
  if (!isAdmin(session)) return new Response('Forbidden', { status: 403 });

  const sp = new URL(req.url).searchParams;
  const format = sp.get('format') === 'xlsx' ? 'xlsx' : 'csv';
  const one = (k: string) => sp.get(k)?.trim() || undefined;
  const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc';

  const locale = await getLocale();
  const t = await getTranslations('leave');
  const tInq = await getTranslations('leave.inquiry');

  const employees = sortInquiryEmployees(await listEmployees(session, scopeIds), locale);
  const selected = pickInquiryEmployee(employees, sp.get('emp') ?? undefined);
  const typeIds = sp.getAll('type').filter(Boolean);
  const statuses = sp.getAll('status').filter((s) => LEAVE_STATUSES.includes(s));

  // Explicit sane cap, mirroring the leave-requests export: a filtered set can be large but one download
  // must stay bounded.
  const { rows } = selected
    ? await listLeaveRequestsPage(session, {
        companyIds: scopeIds,
        employmentIds: [selected.employmentId],
        leaveTypeIds: typeIds.length ? typeIds : undefined,
        statuses: statuses.length ? statuses : undefined,
        q: one('q'),
        from: one('from'),
        to: one('to'),
        sort: one('sort') ?? 'applied',
        dir,
        limit: 10_000,
        offset: 0,
      })
    : { rows: [] };

  // Instants, not date-onlys: route them through the tenant timezone or the exported Applied and
  // Final Approval dates read as YESTERDAY between 00:00 and 08:00 MYT (r85's toISOString class).
  const day = (v: Date | string | null) => (v ? todayInKualaLumpur(new Date(v)) : '');
  const data: ReportData = {
    filename: `leave-records-${selected?.employeeCode ?? 'employee'}-${todayInKualaLumpur()}`,
    title: tInq('recordsTitle'),
    columns: [
      t('filters.employeeId'),
      // fe3eb141 — the short leave reference, so the export carries the handle the screen now shows.
      t('filters.reference'),
      t('colEmployee'),
      t('filters.dateFrom'),
      t('filters.dateTo'),
      t('colDays'),
      tInq('colLeaveCode'),
      t('colStatus'),
      tInq('colReason'),
      tInq('colAttachment'),
      t('colApplied'),
      tInq('colFinalApproval'),
    ],
    rows: rows.map((r) => [
      r.employeeCode ?? '',
      `#${r.id.slice(0, 8)}`,
      r.employee,
      r.startDate,
      r.endDate,
      `${Number(r.days)}${durationLabel(t, r.durationType, r.hours) ? ` ${durationLabel(t, r.durationType, r.hours)}` : ''}`,
      r.typeCode ?? r.leaveType,
      t(`status.${r.status}`),
      r.reason ?? '',
      r.hasDocument ? tInq('attachmentYes') : '',
      day(r.appliedOn),
      day(r.decidedAt),
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
