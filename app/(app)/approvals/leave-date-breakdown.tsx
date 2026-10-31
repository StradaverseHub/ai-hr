'use client';

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CalendarDays } from 'lucide-react';
import { Button, inputCls } from '@/components/ui';
// 4a1abc4a: the per-date days must print like the request TOTAL in the row this popover opens from
// (LeaveDaysCell). Leaving one of them raw would put the drift INSIDE a single screen.
import { formatDays } from '@/lib/day-format';
import { decideLeaveDatesAction } from './actions';

// ADR-0068 §6 / R17 600be8ac / R18 7e532d23 — the per-date DECISION TABLE of ONE per-date-approval leave
// request. R18 restyled the presentation from an inline <details> expander into a MODAL opened from an
// explicit "Decide each date" button on the request row (the reporter's expected UX: click an action →
// a pop-up shows the breakdown). Same radix Dialog pattern as components/leave/cancel-dates-dialog.tsx —
// presentation only, the decision semantics are untouched: one row per requested date with the weekday, the
// day weight, an Approve/Reject choice, and a reason box that is enabled+required only when that row is set
// to Reject. Already-decided dates render read-only (pill + reason). The interactive state is captured into
// a hidden `decisions` field that decideLeaveDatesAction parses and finalizes in one transaction (single
// batch submit). Closing the dialog without submitting discards the staged choices (fresh defaults on
// reopen) — nothing is persisted until Submit.
export type LeaveDateRow = {
  id: string;
  leaveDate: string;
  days: string;
  status: string;
  rejectReason: string | null;
};

type Labels = {
  viewDateBreakdown: string;
  dateBreakdown: string;
  dateColumn: string;
  dayColumn: string;
  daysColumn: string;
  decisionColumn: string;
  reasonColumn: string;
  approve: string;
  reject: string;
  rejectReason: string;
  submitDecisions: string;
  statusPending: string;
  statusApproved: string;
  statusRejected: string;
  employeeRemark: string;
  closeDialog: string;
};

export function LeaveDateBreakdown({
  requestId,
  dates,
  locale,
  remark,
  labels,
  nav,
}: {
  requestId: string;
  dates: LeaveDateRow[];
  locale: string;
  remark?: string | null;
  labels: Labels;
  /** Category-panel return params (2dec6406): posted so the action's redirect keeps the filtered view. */
  nav?: { category: string; sort: string };
}) {
  const pendingDates = useMemo(() => dates.filter((d) => d.status === 'pending'), [dates]);
  // Per pending date: the staged decision + reason. Defaults to Approve (the common case) with an empty reason.
  const freshState = () =>
    Object.fromEntries(pendingDates.map((d) => [d.leaveDate, { decision: 'approved' as const, reason: '' }]));
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Record<string, { decision: 'approved' | 'rejected'; reason: string }>>(freshState);

  const weekday = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(`${iso}T00:00:00`));
    } catch {
      return '';
    }
  };

  const setDecision = (date: string, decision: 'approved' | 'rejected') =>
    setState((s) => ({ ...s, [date]: { ...s[date], decision } }));
  const setReason = (date: string, reason: string) =>
    setState((s) => ({ ...s, [date]: { ...s[date], reason } }));

  const payload = pendingDates.map((d) => ({
    leaveDate: d.leaveDate,
    decision: state[d.leaveDate]?.decision ?? 'approved',
    rejectReason: state[d.leaveDate]?.decision === 'rejected' ? state[d.leaveDate]?.reason : undefined,
  }));
  // Block submit until every Reject row has a non-blank reason (mirrors the server-side guard).
  const missingReason = pendingDates.some(
    (d) => state[d.leaveDate]?.decision === 'rejected' && !state[d.leaveDate]?.reason.trim(),
  );

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
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Dismissing without submitting discards the staged choices — reopening starts from clean defaults,
        // so a half-filled abandoned session can never silently ride into a later submit.
        if (!next) setState(freshState());
      }}
    >
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" className="gap-1.5">
          <CalendarDays className="size-3.5" />
          {labels.viewDateBreakdown}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{labels.dateBreakdown}</Dialog.Title>
          {remark && (
            <Dialog.Description className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/70">{labels.employeeRemark}:</span> {remark}
            </Dialog.Description>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[26rem] text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">{labels.dateColumn}</th>
                  <th className="py-1 pr-2 font-medium">{labels.dayColumn}</th>
                  <th className="py-1 pr-2 text-right font-medium">{labels.daysColumn}</th>
                  <th className="py-1 pr-2 font-medium">{labels.decisionColumn}</th>
                  <th className="py-1 font-medium">{labels.reasonColumn}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dates.map((d) => {
                  const isPending = d.status === 'pending';
                  const chosen = state[d.leaveDate]?.decision ?? 'approved';
                  const p = pill(d.status);
                  return (
                    <tr key={d.id} className="align-top">
                      <td className="py-1.5 pr-2 tabular-nums">{d.leaveDate}</td>
                      <td className="py-1.5 pr-2 text-muted-foreground">{weekday(d.leaveDate)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{formatDays(d.days)}</td>
                      <td className="py-1.5 pr-2">
                        {isPending ? (
                          <div className="inline-flex overflow-hidden rounded-md border border-border">
                            <button
                              type="button"
                              onClick={() => setDecision(d.leaveDate, 'approved')}
                              className={`px-2 py-0.5 text-[11px] font-medium ${
                                chosen === 'approved'
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-background text-muted-foreground hover:bg-muted'
                              }`}
                            >
                              {labels.approve}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDecision(d.leaveDate, 'rejected')}
                              className={`border-l border-border px-2 py-0.5 text-[11px] font-medium ${
                                chosen === 'rejected'
                                  ? 'bg-rose-600 text-white'
                                  : 'bg-background text-muted-foreground hover:bg-muted'
                              }`}
                            >
                              {labels.reject}
                            </button>
                          </div>
                        ) : (
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${p.cls}`}>
                            {p.text}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5">
                        {isPending ? (
                          chosen === 'rejected' ? (
                            <input
                              type="text"
                              value={state[d.leaveDate]?.reason ?? ''}
                              onChange={(e) => setReason(d.leaveDate, e.target.value)}
                              placeholder={labels.rejectReason}
                              className={`${inputCls} w-40 text-xs`}
                            />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )
                        ) : d.status === 'rejected' && d.rejectReason ? (
                          <span className="text-muted-foreground">{d.rejectReason}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" size="sm" variant="outline">
                {labels.closeDialog}
              </Button>
            </Dialog.Close>
            {pendingDates.length > 0 && (
              // The single batch submit — the whole per-date decision set posts in ONE action. Close the
              // dialog as the form posts (same optimistic pattern as cancel-dates-dialog); the server action
              // then revalidates the inbox.
              <form action={decideLeaveDatesAction} onSubmit={() => setOpen(false)}>
                <input type="hidden" name="id" value={requestId} />
                <input type="hidden" name="decisions" value={JSON.stringify(payload)} />
                {nav && (
                  <>
                    <input type="hidden" name="category" value={nav.category} />
                    <input type="hidden" name="sort" value={nav.sort} />
                  </>
                )}
                <Button type="submit" size="sm" disabled={missingReason}>
                  {labels.submitDecisions}
                </Button>
              </form>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
