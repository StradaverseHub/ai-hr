import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { attendanceOnBehalfApprovals, listAttendanceCorrections, resolveApprovedOt } from '@/packs/attendance/service';
import { Card, ErrorBanner, PageHeader, inputCls, pageWideCls } from '@/components/ui';
import { AttendanceWorkflowProgress } from '@/components/attendance-workflow-progress';
import { AttendanceSubmissionButton, AttendanceSubmissionForm } from '@/components/attendance-submission-form';
import { attendanceHistoryDate } from '@/lib/attendance-history-filter';
import { decideCorrectionAction } from '../../../actions';
import { OnBehalfSubjectCard, parseOnBehalfPage } from '../../subject-picker';

/** 96a54ed2 — Approve On Behalf, step two: the requests waiting for the chosen designated approver that this caller
 *  may decide for them, with the same details and decisions as Approvals. The decision records acting_mode on_behalf:
 *  the chosen person stays the designated approver and the caller is recorded as the person who acted. */
export default async function ApproveOnBehalfListPage({ params, searchParams }: { params: Promise<{ employmentId: string }>; searchParams: Promise<{ page?: string; error?: string; toast?: string }> }) {
  await requireModule('attendance');
  const { s } = await scopedSession(), { employmentId } = await params, sp = await searchParams;
  const page = parseOnBehalfPage(sp.page);
  const found = await attendanceOnBehalfApprovals(s, employmentId, page);
  if (!found) notFound();
  const [t, h, locale] = await Promise.all([getTranslations('attendanceOnBehalf'), getTranslations('attendanceHistory'), getLocale()]);
  const slots = new Map(found.rows.map(row => [row.correctionId, row]));
  const rows = found.rows.length ? await listAttendanceCorrections(s, { status: 'pending', requestIds: found.rows.map(row => row.correctionId) }) : [];
  const ordered = found.rows.flatMap(entry => rows.filter(row => row.id === entry.correctionId));
  const minutes = (value: number | null | undefined) => value == null ? h('notRecorded') : h('durationMinutes', { minutes: value });
  const base = `/attendance/on-behalf/approve/${encodeURIComponent(found.designated.employmentId)}`;
  return <div className={pageWideCls + ' space-y-5'}>
    <PageHeader title={t('approveTitle')} description={t('approveListHelp', { name: found.designated.name })} />
    <OnBehalfSubjectCard subject={found.designated} changeHref="/attendance/on-behalf/approve" />
    <ErrorBanner message={sp.error} />
    <Card className="overflow-hidden">
      <h2 className="border-b border-border px-4 py-3 font-semibold">{t('pendingTitle')}</h2>
      {ordered.length ? <ul className="divide-y divide-border">{ordered.map(row => {
        const slot = slots.get(row.id)!;
        const previewOt = row.requestedOtMinutes == null || row.otApprovalCalculation == null || (row.systemOtMinutes == null && row.otApprovalCalculation !== 'requested')
          ? null : resolveApprovedOt(row.requestedOtMinutes, row.systemOtMinutes, row.otApprovalCalculation);
        return <li key={row.id} className="grid gap-4 p-4 text-sm lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-2">
            <p className="font-medium">{row.employee}<span className="ml-2 text-xs text-muted-foreground">{row.employeeCode}</span></p>
            <p className="tabular-nums">{attendanceHistoryDate(row.attendanceDate, locale)} · {h(`subtypes.${row.requestKind ?? 'unknown'}`)}</p>
            {(row.proposedCheckIn || row.proposedCheckOut) && <p>{row.proposedCheckIn?.slice(0, 5) ?? h('notRecorded')} → {row.proposedCheckOut?.slice(0, 5) ?? h('notRecorded')}</p>}
            {row.requestedOtMinutes != null && <div className="space-y-1 text-xs"><p>{h('requestedOt')}: {minutes(row.requestedOtMinutes)}</p><p>{h('recordedOvertime')}: {minutes(row.systemOtMinutes)}</p><p>{h('previewOvertime')}: {minutes(previewOt)}</p></div>}
            <p className="whitespace-pre-wrap">{h('reason')}: {row.reason ?? h('notRecorded')}</p>
            {row.hasAttachment && <a href={`/attendance/requests/attachment/${row.id}`} className="inline-flex min-h-11 items-center text-primary underline">{h('attachment')}</a>}
            {row.workflow && <details><summary className="min-h-11 cursor-pointer py-3 text-primary">{h('progress')}</summary><AttendanceWorkflowProgress workflow={row.workflow} status={row.status} /></details>}
          </div>
          <div className="space-y-4">{(['approved', 'rejected'] as const).map(decision => <AttendanceSubmissionForm key={decision} action={decideCorrectionAction} className="space-y-2">
            <input type="hidden" name="correctionId" value={row.id} /><input type="hidden" name="workflowStage" value={slot.stageIndex} />
            <input type="hidden" name="workflowParticipant" value={slot.slot} /><input type="hidden" name="decision" value={decision} />
            <input type="hidden" name="onBehalfOf" value={found.designated.employmentId} />
            <label className="block text-xs">{h(decision === 'approved' ? 'remarks' : 'rejectionReason')}<textarea required={decision === 'rejected'} name={decision === 'approved' ? 'remarks' : 'rejectReason'} maxLength={1000} className={`${inputCls} w-full`} /></label>
            <AttendanceSubmissionButton className="min-h-11" variant={decision === 'approved' ? 'default' : 'secondary'}>{t(decision === 'approved' ? 'approveOnBehalf' : 'rejectOnBehalf')}</AttendanceSubmissionButton>
          </AttendanceSubmissionForm>)}</div>
        </li>;
      })}</ul> : <p className="p-5 text-sm text-muted-foreground">{t('pendingEmpty')}</p>}
    </Card>
    {(page > 0 || found.more) && <nav className="flex gap-3 text-sm" aria-label={t('pendingTitle')}>
      {page > 0 && <Link className="inline-flex min-h-11 items-center text-primary underline" href={`${base}?page=${page - 1}`}>{t('previous')}</Link>}
      {found.more && <Link className="inline-flex min-h-11 items-center text-primary underline" href={`${base}?page=${page + 1}`}>{t('next')}</Link>}
    </nav>}
    <p className="text-xs text-muted-foreground">{t('approveAudit')}</p>
  </div>;
}
