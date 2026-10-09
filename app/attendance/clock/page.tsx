import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { ownClockToday } from '@/core/attendance-clock-read';
import { attendanceForEmploymentRange } from '@/core/attendance';
import { listShiftsForTenant } from '@/core/roster';
import { getTranslations } from 'next-intl/server';
import { ClockPageClient } from './clock-client';
export default async function AttendanceClockPage() {
  const session=await getSession(), me=await myEmployment(session), t=await getTranslations('attendance.clock');
  if(!me) return <p>{t('notLinked')}</p>;
  const initial=await ownClockToday(session), date=initial.date;
  // r430 — the Switch link is removed, so shiftOptions (the filtered weekday-pattern list it cycled
  // through) is gone too; `shifts` stays — it is still how the CURRENT shift's human-readable name is
  // resolved (today.shift from ownClockToday carries only the code).
  const [range,shifts]=await Promise.all([attendanceForEmploymentRange(session,me.employmentId,date,date),listShiftsForTenant(session)]);
  const resolved=range[0];
  const shift=shifts.find(s=>s.code===resolved?.shiftCode);
  return <div className="mx-auto max-w-6xl space-y-5 pb-[env(safe-area-inset-bottom)]"><ClockPageClient initial={initial} shiftName={shift?.name??null}/></div>;
}
