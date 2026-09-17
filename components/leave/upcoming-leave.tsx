'use client';

/**
 * r302 (board 6c9802c9) — Upcoming Leave: the employee's approved and pending leave from today onwards, soonest
 * first, with dates, days and status. The rows arrive already chosen and ordered by core/my-leave.ts
 * `myUpcomingLeave`; this island only prints them (dates per locale, days through the shared formatter).
 *
 * The side panel's §5 "Upcoming Approved Leave" was removed by 11876072; the reporter asked for upcoming leave
 * back, and it returns as a section of the page — the Leave Details panel still has no upcoming list.
 *
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useTranslations } from 'next-intl';
import { dayPluralCategory, formatDays } from '@/lib/day-format';
import { LEAVE_HISTORY_STATUS_BADGE } from './leave-history-cards';

export type UpcomingLeaveRow = {
  id: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  /** Badge colour key ('pending' | 'approved' | 'partial' | 'pendingCancellation'). */
  statusKey: string;
  /** Pre-translated status text. */
  statusLabel: string;
};

export function UpcomingLeave({ rows, locale }: { rows: UpcomingLeaveRow[]; locale: string }) {
  const t = useTranslations('leave');
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t('myLeave.upcomingEmpty')}</p>;
  const fmtDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${iso}T00:00:00Z`),
      );
    } catch {
      return iso;
    }
  };
  return (
    <ul className="divide-y divide-border" data-testid="upcoming-leave">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-1 gap-1 py-2.5 text-sm sm:grid-cols-[1.4fr_1.6fr_0.7fr_0.8fr] sm:items-center sm:gap-3">
          <span className="font-medium">{r.leaveType}</span>
          <span className="tabular-nums text-muted-foreground">
            {r.startDate === r.endDate ? fmtDate(r.startDate) : `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}`}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {t('myLeave.daysValue', { v: formatDays(r.days), cat: dayPluralCategory(r.days, locale) })}
          </span>
          <span>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${LEAVE_HISTORY_STATUS_BADGE[r.statusKey] ?? 'bg-muted text-muted-foreground'}`}>
              {r.statusLabel}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
