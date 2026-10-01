import { getLocale, getTranslations } from 'next-intl/server';
import { statusLabel } from '@/app/attendance/request-ui';
import { Card } from '@/components/ui';
import type { MyAttendanceRequestRow } from '@/packs/attendance/service';

export async function AttendanceRequestHistory({ rows }: { rows: MyAttendanceRequestRow[] }) {
  const t = await getTranslations('attendance'), me = await getTranslations('me'), locale = await getLocale();
  const dateTime = (date: Date) => new Intl.DateTimeFormat(locale, {timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(date);
  if (!rows.length) return null;
  return <Card className="overflow-hidden"><h2 className="px-4 py-3 font-semibold">{t('requestHistory')}</h2><ul className="divide-y divide-border">{rows.map(row => <li key={row.id} className="space-y-2 break-words px-4 py-3 text-sm">
    <p>{dateTime(row.createdAt)} · {statusLabel(row.status, me, row.proposedCheckIn == null)}</p>
    {row.proposedCheckIn != null && <><p>{t('originalTimes')}: {row.originalClockSnapshot == null ? t('originalNotRecorded') : row.originalClockSnapshot.attendanceId == null ? t('originalNoRecord') : `${row.originalClockSnapshot.originalCheckIn ?? '—'} → ${row.originalClockSnapshot.originalCheckOut ?? '—'}`}</p><p>{t('requestedTimes')}: {row.proposedCheckIn} → {row.proposedCheckOut ?? '—'}</p></>}
    {row.reason && <p>{row.reason}</p>}
    {row.status === 'rejected' && <p className="text-red-700 dark:text-red-300">{t('rejectReasonLabel')}: {row.rejectReason ?? t('rejectNotRecorded')} · {row.decidedAt ? dateTime(row.decidedAt) : '—'}</p>}
  </li>)}</ul></Card>;
}
