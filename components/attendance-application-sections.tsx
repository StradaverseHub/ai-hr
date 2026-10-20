import type { attendanceApplicationDetail } from '@/packs/attendance/service';
import { originalAttendanceReview } from '@/lib/attendance-review-evidence';
import { Card } from './ui';
type Detail = NonNullable<Awaited<ReturnType<typeof attendanceApplicationDetail>>>;
type Translate = (key: string, values?: Record<string, string | number>) => string;

export function AttendanceApplicationSections({ detail, locale, t }: { detail: Detail; locale: string; t: Translate }) {
  const a = detail.application, review = detail.review, record = review?.record, schedule = review?.schedule;
  const date = (v: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${v}T00:00:00Z`));
  const instant = (v: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(v);
  const duration = (v: number | null | undefined) => v == null ? t('notRecorded') : t('durationMinutes', { minutes: v });
  const clock = (v: string | null | undefined) => v ? v.slice(0, 5) : t('notRecorded');
  const anchoredClock = (v: number | null | undefined) => v == null ? t('notRecorded') : `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}${v >= 1440 ? ` (${t('nextDay')})` : ''}`;
  const fields = (values: [string, string][]) => <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{values.map(([label, value]) => <div key={label} className="min-w-0 space-y-1"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-words text-sm font-medium">{value}</dd></div>)}</dl>;
  const original = originalAttendanceReview(detail.events, a.originalClockSnapshot);
  const state = a.status === 'cancelled' ? a.cancellationKind ?? 'withdrawn' : a.status;
  const requestKind = a.requestKind ?? 'unknown';
  return <>
    <Card className="space-y-5 p-5">
      <h2 className="font-semibold">{t('application')}</h2>
      {fields([
        [t('reference'), a.id], [t('status'), t(`statuses.${state}`)], [t('employee'), detail.employee], [t('employeeId'), detail.employeeCode ?? t('notRecorded')],
        [t('company'), detail.company], [t('department'), review?.organisation?.department ?? t('notRecorded')],
        [t('businessUnit'), review?.organisation?.businessUnit ?? t('notRecorded')], [t('positionLabel'), review?.organisation?.position ?? t('notRecorded')],
        [t('applicationType'), t(`types.${detail.applicationType}`)], [t('subtype'), t(`subtypes.${requestKind}`)],
        [t('attendanceDate'), date(a.attendanceDate)], [t('submissionDate'), instant(a.createdAt)],
      ])}
      <p className="text-xs text-muted-foreground">{t('organisationEvidence')}</p>
      <div className="space-y-2 border-t border-border pt-4"><h3 className="text-sm font-medium">{t('submittedApplication')}</h3><p className="whitespace-pre-wrap text-sm">{a.reason || t('notRecorded')}</p>{a.remark && <p className="whitespace-pre-wrap text-sm">{t('remarks')}: {a.remark}</p>}</div>
      {detail.hasAttachment && <a className="inline-flex min-h-11 items-center text-sm text-primary underline" href={`/attendance/requests/attachment/${a.id}`}>{t('attachment')}</a>}
    </Card>
    <Card className="space-y-5 p-5">
      <h2 className="font-semibold">{t('attendanceDetails')}</h2>
      <div className="space-y-3"><h3 className="text-sm font-semibold">{t(`subtypes.${requestKind}`)}</h3><p className="text-sm text-muted-foreground">{t(`kindHelp.${requestKind}`)}</p></div>
      <section className="space-y-3"><h3 className="text-sm font-medium">{t('recordedSchedule')}</h3>
        {schedule ? fields([
          [t('recordedWindow'), `${anchoredClock(schedule.startAbs)} → ${anchoredClock(schedule.endAbs)}`],
          [t('requiredDuration'), duration(schedule.dayType === 'workday' ? schedule.normalMinutesOverride ?? schedule.scheduledMinutes : null)],
          [t('dayKindLabel'), t(`dayKinds.${schedule.dayType}`)], [t('currentShiftName'), review.currentShiftName ?? t('notRecorded')],
        ]) : <p className="text-sm text-muted-foreground">{t('scheduleUnavailable')}</p>}
      </section>
      <section className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-medium">{t('currentAttendance')}</h3>
        {record ? <>{fields([
          [t('checkIn'), clock(record.checkInAt)], [t('checkOut'), clock(record.checkOutAt)],
          [t('recordedResult'), ['present', 'late', 'half_day', 'leave', 'absent'].includes(record.status) ? t(`attendanceStates.${record.status}`) : t('notRecorded')],
          ...(a.requestKind === 'short_hours' ? [[t('qualifyingDuration'), duration(record.workedMinutes)], [t('shortfallDuration'), duration(record.underMinutes)]] as [string, string][] : []),
        ])}{a.requestKind === 'incomplete_entry' && <p className="text-sm">{t(!record.checkInAt && !record.checkOutAt ? 'bothClocksMissing' : !record.checkInAt ? 'clockInMissing' : !record.checkOutAt ? 'clockOutMissing' : 'clockPairComplete')}</p>}</> : <p className="text-sm text-muted-foreground">{t('attendanceUnavailable')}</p>}
        <p className="text-xs text-muted-foreground">{t('currentEvidenceHelp')}</p>
      </section>
      <section className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-medium">{t('originalAttendance')}</h3>
        {original === undefined ? <p className="text-sm text-muted-foreground">{t('originalUnavailable')}</p> : original === null ? <p className="text-sm text-muted-foreground">{t('noPriorRecord')}</p> : fields([
          [t('checkIn'), clock(original.checkIn)], [t('checkOut'), clock(original.checkOut)],
          ...(a.requestKind === 'short_hours' ? [[t('requiredDuration'), duration(original.required)], [t('qualifyingDuration'), duration(original.worked)], [t('shortfallDuration'), duration(original.shortfall)]] as [string, string][] : []),
        ])}
      </section>
      <section className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-medium">{t('reportedDetails')}</h3>
        {a.proposedCheckIn || a.proposedCheckOut ? fields([[t('checkIn'), clock(a.proposedCheckIn)], [t('checkOut'), clock(a.proposedCheckOut)]]) : !a.clockChanges && a.requestedOtMinutes == null && <p className="text-sm text-muted-foreground">{t('notRecorded')}</p>}
        {a.clockChanges && (a.clockChanges.entries.length ? <ul className="space-y-2 text-sm">{a.clockChanges.entries.map((entry, i) => <li key={entry.id ?? i}>{entry.punchAt} · {t(entry.direction)}</li>)}</ul> : <p className="text-sm">{t('removeAll')}</p>)}
        {a.requestedOtMinutes != null && fields([[t('requestedOt'), duration(a.requestedOtMinutes)], [t('approvedOt'), duration(a.approvedOtMinutes)]])}
        {(a.plannedStartTime || a.plannedEndTime) && fields([[t('plannedWindow'), `${clock(a.plannedStartTime)} → ${clock(a.plannedEndTime)}`]])}
        {a.adminAmendment && <div className="space-y-1 rounded-md bg-muted p-3 text-sm"><p>{t('administratorAmendment')}: {clock(a.adminAmendment.checkIn)} → {clock(a.adminAmendment.checkOut)}</p><p>{a.adminAmendment.reason}</p></div>}
      </section>
      {a.rejectReason && <p className="text-sm">{t('rejectionReason')}: {a.rejectReason}</p>}
      {a.cancelledAt && <p className="text-sm">{t(`statuses.${a.cancellationKind ?? 'withdrawn'}`)}: {instant(a.cancelledAt)} · {a.cancellationReason ?? t('notRecorded')}</p>}
    </Card>
  </>;
}
