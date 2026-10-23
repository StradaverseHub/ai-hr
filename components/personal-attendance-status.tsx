import type { AttendanceStatus } from '@/packs/attendance/service';

export const PERSONAL_ATTENDANCE_STATUS_CLASS: Record<AttendanceStatus,string> = {
  present:'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  absent:'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400',
  exempt:'border-border bg-muted text-muted-foreground',
  rest:'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  off:'border-border bg-muted text-muted-foreground',
  ph:'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400',
  on_leave:'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

/** The label carries meaning even without colour. The caller supplies already translated text. */
export function PersonalAttendanceStatus({status,label}:{status:AttendanceStatus;label:string}) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-xs ${PERSONAL_ATTENDANCE_STATUS_CLASS[status]}`}>
    <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden/>{label}
  </span>;
}
