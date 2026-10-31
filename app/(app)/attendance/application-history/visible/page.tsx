import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listAttendanceCorrections, resolveApprovedOt } from '@/packs/attendance/service';
import { PageHeader, Card, ErrorBanner, Button, inputCls, pageWideCls } from '@/components/ui';
import { AttendanceWorkflowProgress } from '@/components/attendance-workflow-progress';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { attendanceHistoryDate } from '@/lib/attendance-history-filter';
import { decideCorrectionAction } from '../../actions';

/** Request-scoped continuation of the former Overview worklist. Reuses its exact reader/writer;
 * frozen participants never acquire an HR history query or Personnel browsing authority. */
export default async function VisibleAttendanceApplications({ searchParams }: {
  searchParams: Promise<{ page?: string; size?: string; error?: string }>;
}) {
  await requireModule('attendance');
  const { s, scopeIds } = await scopedSession(), sp = await searchParams;
  const t = await getTranslations('attendanceHistory'), locale = await getLocale();
  const rows = await listAttendanceCorrections(s, { companyIds: scopeIds, status: 'pending' });
  const page = paginateRows(rows, parsePageQuery(sp));
  const minutes = (value: number | null | undefined) => value == null ? t('notRecorded') : t('durationMinutes', { minutes: value });
  return <div className={pageWideCls}>
    <PageHeader title={t('visibleTitle')} description={t('visibleHelp')} />
    <Link href="/attendance" className="inline-flex min-h-11 items-center text-sm text-primary underline">{t('backToOverview')}</Link>
    <ErrorBanner message={sp.error} />
    <Card className="overflow-hidden">
      <Pager state={page.state} basePath="/attendance/application-history/visible" params={sp} />
      <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">{t('visibleTitle')}</caption>
      <thead className="bg-white text-slate-900"><tr>{['employee', 'attendanceDate', 'reportedDetails', 'reason', 'actions'].map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(key)}</th>)}</tr></thead>
      <tbody className="divide-y divide-border">{page.rows.map(row => {
        const canAct = (s.personId == null || row.personId !== s.personId) && row.canDecide !== false;
        const previewOt = row.requestedOtMinutes == null || row.otApprovalCalculation == null
          || (row.systemOtMinutes == null && row.otApprovalCalculation !== 'requested')
          ? null : resolveApprovedOt(row.requestedOtMinutes, row.systemOtMinutes, row.otApprovalCalculation);
        return <tr key={row.id}>
          <td className="px-4 py-3"><p className="font-medium">{row.employee}</p><p className="text-xs text-muted-foreground">{row.employeeCode}</p></td>
          <td className="px-4 py-3 tabular-nums">{attendanceHistoryDate(row.attendanceDate, locale)}</td>
          <td className="space-y-2 px-4 py-3"><p>{t(`subtypes.${row.requestKind ?? 'unknown'}`)}</p>{(row.proposedCheckIn || row.proposedCheckOut) && <p>{row.proposedCheckIn?.slice(0, 5) ?? t('notRecorded')} → {row.proposedCheckOut?.slice(0, 5) ?? t('notRecorded')}</p>}
            {row.requestedOtMinutes != null && <div className="space-y-1 text-xs"><p>{t('requestedOt')}: {minutes(row.requestedOtMinutes)}</p><p>{t('recordedOvertime')}: {minutes(row.systemOtMinutes)}</p><p>{t('previewOvertime')}: {minutes(previewOt)}</p></div>}
            {row.hasAttachment && <a href={`/attendance/requests/attachment/${row.id}`} className="inline-flex min-h-11 items-center text-primary underline">{t('attachment')}</a>}
            {row.workflow && <details><summary className="min-h-11 cursor-pointer py-3 text-primary">{t('progress')}</summary><AttendanceWorkflowProgress workflow={row.workflow} status={row.status} /></details>}
          </td>
          <td className="max-w-sm whitespace-pre-wrap px-4 py-3">{row.reason ?? t('notRecorded')}</td>
          <td className="px-4 py-3">{canAct ? <div className="min-w-56 space-y-4">{(['approved', 'rejected'] as const).map(decision => <form key={decision} action={decideCorrectionAction} className="space-y-2">
            <input type="hidden" name="correctionId" value={row.id} /><input type="hidden" name="workflowStage" value={row.workflow?.currentStage ?? ''} />
            <input type="hidden" name="returnTo" value="/attendance/application-history/visible" /><input type="hidden" name="decision" value={decision} />
            <input type="hidden" name="workflowParticipant" value={row.workflow?.currentParticipantSlot ?? ''} />
            <label className="block text-xs">{t(decision === 'approved' ? 'remarks' : 'rejectionReason')}<textarea required={decision === 'rejected'} name={decision === 'approved' ? 'remarks' : 'rejectReason'} maxLength={1000} className={`${inputCls} w-full`} /></label>
            <Button type="submit" className="min-h-11" variant={decision === 'approved' ? 'default' : 'secondary'}>{t(decision === 'approved' ? 'approve' : 'reject')}</Button>
          </form>)}</div> : <p className="text-sm text-muted-foreground">{t('notWaitingForYou')}</p>}</td>
        </tr>;
      })}</tbody>
    </table>{!rows.length && <p className="p-5 text-sm text-muted-foreground">{t('visibleEmpty')}</p>}</div>
    </Card>
    <p className="text-xs text-muted-foreground">{t('visibleLimit')}</p>
  </div>;
}
