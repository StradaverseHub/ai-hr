'use client';

import { Button, inputCls } from '@/components/ui';
import { decideLeaveDateAction } from './actions';

// ADR-0068 §6 — the per-date breakdown of ONE per-date-approval leave request, rendered as an inline
// expander (single-pager convention: no route). Each requested date shows a status pill; every PENDING date
// gets an Approve button + a required reject-reason textarea + a Reject button, each posting the request id +
// the specific leaveDate to decideLeaveDateAction. Approved/rejected dates show their pill (+ reason). This is
// a client component only for the <details> toggle; the forms are server actions.
export type LeaveDateRow = {
  id: string;
  leaveDate: string;
  days: string;
  status: string;
  rejectReason: string | null;
};

export function LeaveDateBreakdown({
  requestId,
  dates,
  labels,
}: {
  requestId: string;
  dates: LeaveDateRow[];
  labels: {
    viewDateBreakdown: string;
    dateBreakdown: string;
    approve: string;
    reject: string;
    rejectReason: string;
    statusPending: string;
    statusApproved: string;
    statusRejected: string;
  };
}) {
  const pill = (status: string) => {
    switch (status) {
      case 'approved':
        return { text: labels.statusApproved, cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' };
      case 'rejected':
        return { text: labels.statusRejected, cls: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' };
      default:
        return { text: labels.statusPending, cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' };
    }
  };
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline">
        {labels.viewDateBreakdown}
      </summary>
      <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/30 p-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {labels.dateBreakdown}
        </div>
        {dates.map((d) => {
          const p = pill(d.status);
          return (
            <div key={d.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-border pt-2 first:border-0 first:pt-0">
              <div className="min-w-0">
                <span className="tabular-nums text-sm">{d.leaveDate}</span>
                <span className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${p.cls}`}>
                  {p.text}
                </span>
                {d.status === 'rejected' && d.rejectReason && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{d.rejectReason}</div>
                )}
              </div>
              {d.status === 'pending' && (
                <div className="flex flex-col items-end gap-1">
                  <form action={decideLeaveDateAction}>
                    <input type="hidden" name="id" value={requestId} />
                    <input type="hidden" name="leaveDate" value={d.leaveDate} />
                    <input type="hidden" name="decision" value="approved" />
                    <Button type="submit" size="sm">
                      {labels.approve}
                    </Button>
                  </form>
                  <form action={decideLeaveDateAction} className="flex flex-col items-end gap-1">
                    <input type="hidden" name="id" value={requestId} />
                    <input type="hidden" name="leaveDate" value={d.leaveDate} />
                    <input type="hidden" name="decision" value="rejected" />
                    <textarea
                      name="rejectReason"
                      required
                      rows={2}
                      placeholder={labels.rejectReason}
                      className={`${inputCls} w-48 resize-none text-xs`}
                    />
                    <Button type="submit" size="sm" variant="outline">
                      {labels.reject}
                    </Button>
                  </form>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
