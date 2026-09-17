'use client';

/**
 * Self-service My Leave History — tabs, one row per request, and a slide-out View panel.
 *
 * r302 (board 6c9802c9) reshaped this island to the approved plan: "My Leave History gets four tabs: Pending,
 * Approved, Rejected and Cancelled. Each row shows the leave type, dates, days, the date applied, the status, the
 * approver, and a View button." The tabs are LINKS (server-filtered through the history read's own statuses
 * filter — no client-side filtering of a capped page), built by the page and handed in; the rows are the tab's
 * records. It was compact cards before (feedback 657962ec); the side-sheet those cards opened is the same one,
 * extended with what the plan asks View to show: reason, date submitted, the approval progress step by step with
 * each approver's name and decision time (current step highlighted), a rejection's reason and a cancellation's
 * who and when.
 *
 * DB-free client island: every record arrives as a plain PRE-TRANSLATED entry from the RSC. The action dialogs
 * (EditLeaveDialog / CancelLeaveDialog / CancelDatesDialog) and the LeaveDateOutcome breakdown are RSC-rendered
 * nodes passed through `actions` / `dateOutcome` — each dialog is its own portal-based Radix form with the hidden
 * leaveRequestId INSIDE its own <form>, so submitting from within this panel posts the same server actions
 * unchanged. Rendered ONLY in the detail panel, never on a row.
 *
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { type ReactNode, useState } from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
// 4a1abc4a: the paid/unpaid split lines are day figures off the same ledger, so they print like every
// other day figure rather than however JavaScript happened to stringify the number.
import { dayPluralCategory, formatDays } from '@/lib/day-format';

/** Status badge colours — shared with Upcoming Leave (incl. the derived 'partial' / 'pendingCancellation' keys). */
export const LEAVE_HISTORY_STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  cancelled: 'bg-muted text-muted-foreground',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  // r301 (83511d3b) — an approved leave with a cancellation waiting for approval.
  pendingCancellation: 'bg-orange-50 text-orange-800 dark:bg-orange-500/10 dark:text-orange-400',
};

/** r301 — one line of a progress list: done (green), current (amber), upcoming (hollow); r302 adds rejected. */
const PROGRESS_DOT: Record<'done' | 'current' | 'upcoming' | 'rejected', string> = {
  done: 'bg-emerald-600 dark:bg-emerald-400',
  current: 'bg-amber-500 ring-4 ring-amber-200 dark:ring-amber-500/30',
  upcoming: 'border-2 border-muted-foreground/40 bg-transparent',
  rejected: 'bg-rose-600 dark:bg-rose-400',
};

export type LeaveProgressStep = {
  /** Pre-translated, e.g. "Level 2 · Department Head · Dora Head". */
  label: string;
  /** Pre-translated second line, e.g. "Approved 12 Oct 2026, 09:14" or "Waiting for approval". */
  detail: string | null;
  state: 'done' | 'current' | 'upcoming' | 'rejected';
};

export type LeaveHistoryTabLink = {
  key: string;
  label: string;
  count: number;
  href: string;
  active: boolean;
};

export type LeaveHistoryEntry = {
  id: string;
  leaveType: string;
  /** Emergency-Leave child tag (0106) — pre-translated; null for ordinary requests. */
  groupLabel: string | null;
  /** ISO yyyy-mm-dd bounds — formatted per locale client-side. */
  startDate: string;
  endDate: string;
  days: number;
  /** r302 — the date the request was submitted, tenant-local ISO yyyy-mm-dd. */
  /** Null when the submission date is not known (a split made before r299 recorded its lineage). */
  appliedOn: string | null;
  /** r302 — the employee's own reason, as submitted. */
  reason: string | null;
  /** fef49b9a — the paid/unpaid breakdown, PRE-TRANSLATED and pre-split by lib/leave-split.ts on the
   *  server (this island translates nothing). null when the request was fully covered by the balance,
   *  which is the common case and renders exactly as before. */
  splitRows: { label: string; days: number; unpaid: boolean }[] | null;
  /** Pre-translated card duration suffix (half-day / hourly session); null for full-day rows. */
  sessionSuffix: string | null;
  /** Pre-translated panel Session value — always present ("Full day" default, hourly incl. its window). */
  sessionLabel: string;
  /** Badge colour key: 'partial' for the derived partially-approved display, else the DB status. */
  statusKey: string;
  /** Pre-translated status text (incl. "Partially approved"). */
  statusLabel: string;
  /**
   * r302 — the row's Approver cell, pre-translated: "Waiting for Marcus Manager · Level 2 of 2" on a pending
   * request, "Approved by …" / "Rejected by …" on a decided one. Names come from migration 0472's read of the
   * caller's OWN requests; a role level (HR, Payroll) is named by its label, never by a person. null ⇒ "—".
   */
  approverLine: string | null;
  /**
   * r302 — the approval progress for the View panel: Submitted → each level (kind label, approver name, decision
   * and time) → the outcome, the current level highlighted. Pre-translated. null when there is nothing to show.
   */
  approvalProgress: LeaveProgressStep[] | null;
  /** r302 — the whole-request rejection reason (the `leave-request.rejected` event), pre-trimmed. */
  rejectionReason: string | null;
  /**
   * r302 fix pass (verifier defect 7) — a PER-DATE rejection: each rejected date (ISO yyyy-mm-dd, formatted here
   * in the viewer's locale like every other date in the history) with its own reason. Replaces the audit string
   * of raw ISO dates the event also carries. Absent or null for a whole-request rejection.
   */
  rejectedDates?: { date: string; reason: string | null }[] | null;
  /** r302 — who cancelled the request and when (and the cancellation's reason), pre-translated lines. */
  cancellation: { lines: string[]; reason: string | null } | null;
  /** Pre-translated ADR-0065 pending-cancellation pill; null when none. */
  cancelPendingLabel: string | null;
  /**
   * r301 (83511d3b) — where a pending cancellation stands, pre-translated on the server: requested (date),
   * each approval LEVEL of the copied chain (approved / waiting / not reached — levels only, no approver
   * names), then "Cancelled · days returned to your balance". null when nothing is pending.
   */
  cancelProgress: {
    steps: { label: string; state: 'done' | 'current' | 'upcoming' }[];
    dates: string;
    note: string | null;
  } | null;
  /** Own-attachment link + pre-translated label; null when the request carries no document. */
  documentHref: string | null;
  documentLabel: string | null;
  /** RSC-rendered Edit / Cancel / Cancel-dates dialogs — detail panel ONLY, never on the row. */
  actions: ReactNode | null;
  /** RSC-rendered per-date outcome breakdown (LeaveDateOutcome) — detail panel ONLY. */
  dateOutcome: ReactNode | null;
};

export function LeaveHistoryCards({
  entries,
  locale,
  tabs,
  emptyLabel,
}: {
  entries: LeaveHistoryEntry[];
  locale: string;
  /** r302 — the Pending / Approved / Rejected / Cancelled tab links, built by the page. Omitted ⇒ no tab bar. */
  tabs?: LeaveHistoryTabLink[];
  /** r302 — pre-translated sentence for a tab with no records. */
  emptyLabel?: string;
}) {
  const t = useTranslations('leave');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (entries.length === 0 && !tabs) return null;

  const selected = entries.find((e) => e.id === selectedId) ?? null;

  const fmtDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(
        new Date(`${iso}T00:00:00`),
      );
    } catch {
      return iso;
    }
  };
  const range = (e: LeaveHistoryEntry) =>
    e.startDate === e.endDate ? fmtDate(e.startDate) : `${fmtDate(e.startDate)} – ${fmtDate(e.endDate)}`;
  const badgeCls = (key: string) => LEAVE_HISTORY_STATUS_BADGE[key] ?? 'bg-muted text-muted-foreground';
  // 4a1abc4a: the duration is the request's day count — the same figure the Days column and the ledger row
  // carry — so it prints at 2dp like them. `cat` SELECTS, `v` PRINTS — see dayPluralCategory for why.
  const durationLine = (e: LeaveHistoryEntry) =>
    `${t('durationLine', { v: formatDays(e.days), cat: dayPluralCategory(e.days, locale) })}${e.sessionSuffix ? ` · ${e.sessionSuffix}` : ''}`;
  /** r302 — the row's Days cell: the day figure (and session), without the panel's "Duration:" prefix. */
  const daysCell = (e: LeaveHistoryEntry) =>
    `${t('myLeave.daysValue', { v: formatDays(e.days), cat: dayPluralCategory(e.days, locale) })}${e.sessionSuffix ? ` · ${e.sessionSuffix}` : ''}`;

  const openDetails = (id: string) => {
    setSelectedId(id);
    setOpen(true);
  };

  /** One labelled row of the detail view. */
  const field = (label: string, value: ReactNode) => (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );

  /** A header cell that doubles as the mobile label of the value beside it. */
  const cellLabel = (label: string) => (
    <span className="mr-2 text-xs font-medium text-muted-foreground md:hidden">{label}</span>
  );

  const splitLine = (rows: NonNullable<LeaveHistoryEntry['splitRows']>) =>
    rows.map((row, i) => (
      <span key={row.label + i}>
        {i > 0 && ' · '}
        <span className={row.unpaid ? 'text-amber-700 dark:text-amber-400' : undefined}>
          {row.label} {formatDays(row.days)}
        </span>
      </span>
    ));

  return (
    <>
      {/* ── Tabs (links; the page filters by status on the server) ─────────────────────────────────── */}
      {tabs && (
        <nav aria-label={t('myLeave.historyTabsLabel')} className="flex flex-wrap gap-1.5">
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                tab.active
                  ? 'border-primary/40 bg-primary/10 font-semibold text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                {tab.count}
              </span>
            </Link>
          ))}
        </nav>
      )}

      {/* ── Card list: one row per request (essentials only — no actions, no document link, no outcomes) ── */}
      {entries.length === 0 ? (
        emptyLabel ? <p className="mt-3 text-sm text-muted-foreground">{emptyLabel}</p> : null
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">{t('myLeave.colLeaveType')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('myLeave.colDates')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('myLeave.colDays')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('myLeave.colApplied')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('myLeave.colStatus')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('myLeave.colApprover')}</th>
                <th scope="col" className="py-2 font-medium"><span className="sr-only">{t('myLeave.view')}</span></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="block border-b border-border py-2.5 md:table-row md:py-0" data-testid="leave-history-row">
                  <td className="block py-0.5 font-medium md:table-cell md:py-2.5 md:pr-3">
                    {e.leaveType}
                    {e.groupLabel && (
                      <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {e.groupLabel}
                      </span>
                    )}
                    {/* fef49b9a — the breakdown, when the balance did not cover the whole application. */}
                    {e.splitRows && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{splitLine(e.splitRows)}</span>}
                  </td>
                  <td className="block py-0.5 tabular-nums text-muted-foreground md:table-cell md:py-2.5 md:pr-3">
                    {cellLabel(t('myLeave.colDates'))}
                    {range(e)}
                  </td>
                  <td className="block py-0.5 tabular-nums text-muted-foreground md:table-cell md:py-2.5 md:pr-3">
                    {cellLabel(t('myLeave.colDays'))}
                    {daysCell(e)}
                  </td>
                  <td className="block py-0.5 tabular-nums text-muted-foreground md:table-cell md:py-2.5 md:pr-3">
                    {cellLabel(t('myLeave.colApplied'))}
                    {e.appliedOn ? fmtDate(e.appliedOn) : '—'}
                  </td>
                  <td className="block py-0.5 md:table-cell md:py-2.5 md:pr-3">
                    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badgeCls(e.statusKey)}`}>
                      {e.statusLabel}
                    </span>
                  </td>
                  <td className="block py-0.5 text-xs text-muted-foreground md:table-cell md:py-2.5 md:pr-3">
                    {cellLabel(t('myLeave.colApprover'))}
                    {e.approverLine ?? '—'}
                  </td>
                  <td className="block py-0.5 md:table-cell md:py-2.5 md:text-right">
                    <button
                      type="button"
                      onClick={() => openDetails(e.id)}
                      aria-label={t('viewDetails')}
                      className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
                    >
                      {t('myLeave.view')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Slide-out detail panel (LeaveDetailsPanel pattern: controlled right side-sheet) ─────────── */}
      {selected && (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <Dialog.Content
              className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-popover text-popover-foreground shadow-lg"
              aria-describedby={undefined}
            >
              {/* Keyed per record so nested dialog state never bleeds across selections. */}
              <div key={selected.id} className="flex min-h-0 flex-1 flex-col">
                <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-popover px-5 py-4">
                  <div className="min-w-0">
                    <Dialog.Title className="text-base font-semibold">{t('details.title')}</Dialog.Title>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{selected.leaveType}</p>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label={t('breakdown.close')}
                      className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/40"
                    >
                      <X className="size-4" />
                    </button>
                  </Dialog.Close>
                </div>

                <dl className="space-y-4 px-5 py-4">
                  {field(
                    t('details.leaveType'),
                    <>
                      {selected.leaveType}
                      {selected.groupLabel && (
                        <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {selected.groupLabel}
                        </span>
                      )}
                      {/* fef49b9a — how much of it was actually paid. */}
                      {selected.splitRows && (
                        <span className="mt-1 block text-xs text-muted-foreground">{splitLine(selected.splitRows)}</span>
                      )}
                    </>,
                  )}
                  {field(
                    t('details.duration'),
                    <>
                      <span className="tabular-nums">{range(selected)}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{durationLine(selected)}</span>
                    </>,
                  )}
                  {field(t('details.session'), selected.sessionLabel)}
                  {field(t('myLeave.reason'), selected.reason?.trim() ? selected.reason : '—')}
                  {field(t('myLeave.submitted'), <span className="tabular-nums">{selected.appliedOn ? fmtDate(selected.appliedOn) : '—'}</span>)}
                  {field(
                    t('details.status'),
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badgeCls(selected.statusKey)}`}>
                        {selected.statusLabel}
                      </span>
                      {/* r301: the status badge already reads "Pending Cancellation" — the pill would repeat it. */}
                      {selected.cancelPendingLabel && selected.statusKey !== 'pendingCancellation' && (
                        <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                          {selected.cancelPendingLabel}
                        </span>
                      )}
                    </span>,
                  )}
                  {field(
                    t('details.attachment'),
                    selected.documentHref ? (
                      <a
                        href={selected.documentHref}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {selected.documentLabel}
                      </a>
                    ) : (
                      '—'
                    ),
                  )}
                  {(selected.rejectionReason || (selected.rejectedDates?.length ?? 0) > 0) &&
                    field(
                      t('myLeave.rejectionReason'),
                      <>
                        {selected.rejectionReason && <span className="block">{selected.rejectionReason}</span>}
                        {selected.rejectedDates && selected.rejectedDates.length > 0 && (
                          <ul className="space-y-0.5">
                            {selected.rejectedDates.map((d) => (
                              <li key={d.date}>
                                <span className="tabular-nums">{fmtDate(d.date)}</span>
                                {d.reason ? ` · ${d.reason}` : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </>,
                    )}
                  {selected.cancellation &&
                    field(
                      t('myLeave.cancellation'),
                      <>
                        {selected.cancellation.lines.map((line) => (
                          <span key={line} className="block">
                            {line}
                          </span>
                        ))}
                        {selected.cancellation.reason && (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {t('myLeave.cancellationReason', { reason: selected.cancellation.reason })}
                          </span>
                        )}
                      </>,
                    )}
                </dl>

                {/* r302 — the approval progress, step by step, the current level highlighted. */}
                {selected.approvalProgress && selected.approvalProgress.length > 0 && (
                  <div className="px-5 pb-4" data-testid="approval-progress">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('myLeave.approvalProgress')}</p>
                    <ol className="mt-2 space-y-2.5">
                      {selected.approvalProgress.map((step, i) => (
                        <li
                          key={i}
                          aria-current={step.state === 'current' ? 'step' : undefined}
                          className={`flex items-start gap-2.5 text-sm ${step.state === 'current' ? 'font-semibold text-foreground' : step.state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'}`}
                        >
                          <span aria-hidden className={`mt-1.5 inline-block size-2.5 shrink-0 rounded-full ${PROGRESS_DOT[step.state]}`} />
                          <span>
                            {step.label}
                            {step.detail && <span className="block text-xs font-normal text-muted-foreground">{step.detail}</span>}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* r301 (83511d3b) — Pending Cancellation progress: the same levels, in the same order, as the
                    original request, and nothing about who holds each one. */}
                {selected.cancelProgress && (
                  <div className="px-5 pb-4">
                    <p className="text-xs text-muted-foreground">{selected.cancelProgress.dates}</p>
                    <ol className="mt-2 space-y-2">
                      {selected.cancelProgress.steps.map((step, i) => (
                        <li
                          key={i}
                          className={`flex items-center gap-2.5 text-sm ${step.state === 'current' ? 'font-medium text-foreground' : step.state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'}`}
                        >
                          <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${PROGRESS_DOT[step.state]}`} />
                          {step.label}
                        </li>
                      ))}
                    </ol>
                    {selected.cancelProgress.note && (
                      <p className="mt-2 text-xs text-muted-foreground">{selected.cancelProgress.note}</p>
                    )}
                  </div>
                )}

                {/* Per-date outcome breakdown for a partially-approved record (R17 600be8ac ask #6). */}
                {selected.dateOutcome && <div className="px-5 pb-4">{selected.dateOutcome}</div>}

                {/* Actions live HERE, not on the row: Edit + Cancel Leave (pending) or Cancel dates
                    (approved give-back). Each is its own portal-based dialog posting its own form. */}
                {selected.actions && (
                  <div className="mt-auto border-t border-border px-5 py-4">
                    <div className="flex flex-wrap gap-2">{selected.actions}</div>
                  </div>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}
