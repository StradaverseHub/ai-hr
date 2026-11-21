import type { AttendanceLevelStatus, AttendanceProgressHeadline } from './attendance-progress';

/** A next-intl translator for the attendanceHistory namespace (messages are untyped in this repository). */
type Translate = (key: string, values?: Record<string, string | number>) => string;


/** 237c31e6: one status word per level and per approver; Escalated keeps its own label. */
export function attendanceLevelStatusLabel(t:Translate, status:AttendanceLevelStatus): string {
  switch (status) {
    case 'pending_approval': return t('pendingApproval');
    case 'waiting_previous': return t('waitingPreviousLevel');
    case 'approved': return t('statuses.approved');
    case 'rejected': return t('statuses.rejected');
    case 'escalated': return t('escalatedStage');
    case 'skipped': return t('skippedNotRequired');
    default: return t('notRequired');
  }
}
/** "First-level approval completed. Waiting for second-level approval." — or the final outcome. */
export function attendanceProgressHeadlineText(t:Translate, locale:string, headline:AttendanceProgressHeadline): string {
  const ordinal = (level:number) => t(`levelOrdinal.${Math.min(Math.max(level,1),10)}`);
  const text = headline.kind === 'final' ? t('progressFinal', { status: t(`statuses.${headline.status}`) })
    : headline.kind === 'completed' ? t('progressMessage', { completed: ordinal(headline.completed), waiting: ordinal(headline.waiting) })
    : t('progressWaiting', { waiting: ordinal(headline.waiting) });
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

