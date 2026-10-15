/**
 * Employee Leave Record export (feedback 953be4b0) — the currently filtered transaction list, CSV or Excel.
 *
 * Admin-gated and read-only (no DomainEvent — downloading a report mutates nothing), and it reads through
 * the same `listLeaveRequestsPage` the screen does with the same params, so the file matches the screen.
 * The document itself is never exported — only whether one exists — so the export cannot become a way
 * around the per-request attachment authorization.
 */
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { toCsvReport, toXlsxReport, type ReportData } from '@/lib/report-export';
import { parseInquiryQuery, inquirySearchParams, InquiryQueryError } from '@/lib/leave-inquiry-query';
import { leaveInquirySnapshot, leaveInquiryRecordsPageTx, collectInquiryExport } from '@/packs/leave/service';
import { durationLabel } from '@/lib/leave-duration';
import { formatDays } from '@/lib/day-format';
import { todayInKualaLumpur } from '@/lib/hr-date';


export async function GET(req: Request) {
  const { s: session, scopeIds } = await scopedSession();
  if (!isAdmin(session)) return new Response('Forbidden', { status: 403 });

  const sp = new URL(req.url).searchParams;
  const tError = await getTranslations('leave.inquiry');
  try {
  const query = parseInquiryQuery(inquirySearchParams(sp), 'records');
  const { format } = query;

  const t = await getTranslations('leave');
  const tInq = await getTranslations('leave.inquiry');

  const { rows, selected } = await leaveInquirySnapshot(session, scopeIds, query, async (tx, inquiry) => ({
    rows: await collectInquiryExport(window => leaveInquiryRecordsPageTx(tx, session, inquiry, query, window)), selected: inquiry.selected,
  }));

  // Instants, not date-onlys: route them through the tenant timezone or the exported Applied and
  // Final Approval dates read as YESTERDAY between 00:00 and 08:00 MYT (r85's toISOString class).
  const day = (v: Date | string | null) => (v ? todayInKualaLumpur(new Date(v)) : '');
  const data: ReportData = {
    filename: `leave-records-${selected?.employeeCode ?? 'all-employees'}-${todayInKualaLumpur()}`,
    title: tInq('recordsTitle'),
    columns: [
      t('filters.employeeId'),
      // fe3eb141 — the short leave reference, so the export carries the handle the screen now shows.
      t('filters.reference'),
      t('colEmployee'),
      t('filters.company'),
      t('filters.department'),
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
      r.company,
      r.department ?? '',
      r.startDate,
      r.endDate,
      // 4a1abc4a: the file prints the same day figure as the screen it exports. `r.days` is non-nullable
      // here, so the em-dash placeholder is unreachable and no blank-cell override is needed.
      `${formatDays(r.days)}${durationLabel(t, r.durationType, r.hours) ? ` ${durationLabel(t, r.durationType, r.hours)}` : ''}`,
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
  } catch (error) {
    if (!(error instanceof InquiryQueryError)) throw error;
    return new Response(tError(error.message.startsWith('Export exceeds') ? 'exportLimit' : error.message.startsWith('Results changed') ? 'exportChanged' : 'invalidQuery'), { status: 400 });
  }
}
