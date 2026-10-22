import { redirect } from 'next/navigation';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { attendanceCalendarHref, resolveAttendanceCalendarState, type AttendanceCalendarQuery } from '../my-roster/attendance-links';

/** Retained bookmarks enter the one personal Calendar/List shell with their range and paging. */
export default async function MyAttendanceRecordsPage({searchParams}:{searchParams:Promise<AttendanceCalendarQuery>}) {
  await requireModule('attendance');
  await scopedSession();
  const query=await searchParams;
  redirect(attendanceCalendarHref(resolveAttendanceCalendarState({...query,tab:'list'},todayInKualaLumpur())));
}
