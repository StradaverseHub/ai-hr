import type { SessionContext } from '../../db/client';
import { myRosterWindow } from '../../core/roster';
import { attendanceForEmploymentRange } from '../../core/attendance';
import { flagOf, statusOf } from '../../core/attendance-derive';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { assertModuleGate } from '../../core/module-gate';

/** Self-service composition: the caller cannot supply an employment or company selection. */
export async function myAttendanceCalendarWindow(ctx: SessionContext, window: { from: string; to: string }) {
  assertModuleGate(ctx, 'attendance');
  const roster = await myRosterWindow(ctx, window);
  if (!roster) return null;
  const rows = await attendanceForEmploymentRange(ctx, roster.employmentId, window.from, window.to);
  const today = todayInKualaLumpur();
  const attendance = new Map(rows.map(row => {
    const status = statusOf(row);
    return [row.date, {
      // A planned working day in the future is not an absence.
      status: row.date > today && !row.attendanceId && status === 'absent' ? null : status,
      flag: flagOf(row),
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
    }];
  }));
  return { ...roster, days: roster.days.map(day => ({ ...day, attendance: attendance.get(day.date) ?? null })) };
}
