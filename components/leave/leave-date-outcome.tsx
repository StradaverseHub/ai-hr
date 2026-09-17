// R17 600be8ac ask #4/#6 — read-only per-date outcome list for the EMPLOYEE. Shown under a request on /me
// (and reusable elsewhere) so the person can see date-by-date which days were approved / rejected and the
// rejection reason — making the "tap to see the breakdown" notification promise real. Server component (no
// interactivity); weekday is derived from the locale via Intl (no i18n keys needed).

export type LeaveDateOutcomeRow = {
  id: string;
  leaveDate: string;
  days: string;
  status: string;
  rejectReason: string | null;
};

export function LeaveDateOutcome({
  dates,
  locale,
  labels,
}: {
  dates: LeaveDateOutcomeRow[];
  locale: string;
  labels: {
    title: string;
    approved: string;
    rejected: string;
    pending: string;
    /** r302 — a date given back by an approved cancellation reads 'cancelled' (the split moves its row). */
    cancelled: string;
    reason: string;
  };
}) {
  if (dates.length === 0) return null;
  // r302 — the date in the viewer's own format, not the ISO string (the rest of the history formats dates).
  const shortDate = (iso: string) => {
    try {
      // The history's own format (components/leave/leave-history-cards.tsx fmtDate), so one View panel reads one way.
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
    } catch {
      return iso;
    }
  };
  const weekday = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(`${iso}T00:00:00`));
    } catch {
      return '';
    }
  };
  const pill = (status: string) => {
    switch (status) {
      case 'approved':
        return { text: labels.approved, cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' };
      case 'rejected':
        return { text: labels.rejected, cls: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' };
      case 'cancelled':
        return { text: labels.cancelled, cls: 'bg-muted text-muted-foreground' };
      default:
        return { text: labels.pending, cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' };
    }
  };
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline">
        {labels.title}
      </summary>
      <ul className="mt-1.5 space-y-1 rounded-lg border border-border bg-muted/30 p-2 text-xs">
        {dates.map((d) => {
          const p = pill(d.status);
          return (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-border pt-1.5 first:border-0 first:pt-0">
              <span className="tabular-nums text-muted-foreground">
                {shortDate(d.leaveDate)} <span className="text-muted-foreground/70">{weekday(d.leaveDate)}</span>
              </span>
              <span className="flex flex-col items-end gap-0.5">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${p.cls}`}>
                  {p.text}
                </span>
                {d.status === 'rejected' && d.rejectReason && (
                  <span className="text-[11px] text-muted-foreground">
                    {labels.reason}: {d.rejectReason}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
