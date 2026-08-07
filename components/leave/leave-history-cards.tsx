'use client';

/**
 * Self-service Leave History — compact cards + slide-out detail panel (feedback 657962ec).
 *
 * Replaces the dense one-line-per-record list on /leave (My Absence) for the PERSONAL view: each leave
 * record becomes a scannable card carrying ONLY the essentials — leave type, date range, duration and a
 * status badge — plus a "View details" trigger. Everything else (session, approval stage, per-date outcome
 * breakdown, document link, and the Edit / Cancel / Cancel-dates actions) moves into a right-side slide-out
 * detail panel following the LeaveDetailsPanel pattern (one controlled Radix side-sheet; the card is the
 * trigger, this island owns the open + selected state). The HR admin table is untouched.
 *
 * DB-free client island: every record arrives as a plain pre-translated entry from the RSC. The action
 * dialogs (EditLeaveDialog / CancelLeaveDialog / CancelDatesDialog) and the LeaveDateOutcome breakdown are
 * RSC-rendered nodes passed through `actions` / `dateOutcome` — each dialog is its own portal-based Radix
 * form with the hidden leaveRequestId INSIDE its own <form>, so submitting from within this panel posts the
 * same server actions unchanged (no form bridge needed). Rendered ONLY in the detail panel, never on cards.
 *
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { type ReactNode, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
// 4a1abc4a: the paid/unpaid split lines are day figures off the same ledger, so they print like every
// other day figure rather than however JavaScript happened to stringify the number.
import { dayPluralCategory, formatDays } from '@/lib/day-format';

/** Status badge colours — mirrors the page's REQ_STATUS map (incl. the derived 'partial' display key). */
const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
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
  /** Pre-translated pending-approval stage line (Manager review / HR review); null unless pending. */
  stageLabel: string | null;
  /** The person this pending request is waiting on (feedback 567333b7). Null unless the current step is a
   *  direct-manager one — the role-based kinds stay described by `stageLabel` rather than named, because
   *  they resolve to a SET of people and naming one of them would be untrue. */
  approverName: string | null;
  approverPersonId: string | null;
  /** Pre-translated ADR-0065 pending-cancellation pill; null when none. */
  cancelPendingLabel: string | null;
  /** Own-attachment link + pre-translated label; null when the request carries no document. */
  documentHref: string | null;
  documentLabel: string | null;
  /** RSC-rendered Edit / Cancel / Cancel-dates dialogs — detail panel ONLY, never on the card. */
  actions: ReactNode | null;
  /** RSC-rendered per-date outcome breakdown (LeaveDateOutcome) — detail panel ONLY. */
  dateOutcome: ReactNode | null;
};

export function LeaveHistoryCards({ entries, locale }: { entries: LeaveHistoryEntry[]; locale: string }) {
  const t = useTranslations('leave');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

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
  const badgeCls = (key: string) => STATUS_BADGE[key] ?? 'bg-muted text-muted-foreground';
  // 4a1abc4a: the duration is the request's day count — the same figure the Days column and the ledger row
  // carry — so it prints at 2dp like them. `durationLine` is an ICU plural in en/ta only (ms/zh/th/vi were
  // already plain).
  //
  // `cat` SELECTS, `v` PRINTS — see leave-balance-card.tsx and dayPluralCategory for why neither a bare
  // placeholder nor a plain ICU plural is correct here.
  const durationLine = (e: LeaveHistoryEntry) =>
    `${t('durationLine', { v: formatDays(e.days), cat: dayPluralCategory(e.days, locale) })}${e.sessionSuffix ? ` · ${e.sessionSuffix}` : ''}`;

  const openDetails = (id: string) => {
    setSelectedId(id);
    setOpen(true);
  };

  /** One labelled row of the detail view (Leave Type / Duration / Session / Status / Attachment). */
  const field = (label: string, value: ReactNode) => (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );

  return (
    <>
      {/* ── Card list (essentials only — no actions, no document link, no stage detail) ─────────────── */}
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.id} className="rounded-xl border border-border bg-background p-3.5">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                {e.leaveType}
                {e.groupLabel && (
                  <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {e.groupLabel}
                  </span>
                )}
              </span>
              <span
                className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badgeCls(e.statusKey)}`}
              >
                {e.statusLabel}
              </span>
            </div>
            <p className="mt-2 text-sm tabular-nums text-muted-foreground">{range(e)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{durationLine(e)}</p>
            {/* fef49b9a — the breakdown, when the balance did not cover the whole application. It is ONE
                request with one approve action; this only says how the days were charged. Rendered under
                the duration line rather than replacing the type name above, so a split request still
                reads as the type the employee applied for. */}
            {e.splitRows && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {e.splitRows.map((row, i) => (
                  <span key={row.label + i}>
                    {i > 0 && ' · '}
                    <span className={row.unpaid ? 'text-amber-700 dark:text-amber-400' : undefined}>
                      {row.label} {formatDays(row.days)}
                    </span>
                  </span>
                ))}
              </p>
            )}
            <button
              type="button"
              onClick={() => openDetails(e.id)}
              className="mt-2.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('viewDetails')}
            </button>
          </li>
        ))}
      </ul>

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
                      {/* fef49b9a — the breakdown, on the detail panel as well as the card. This is where
                          an employee comes to find out how much of it was actually paid, so a single
                          combined line is the least useful place to leave it. */}
                      {selected.splitRows && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {selected.splitRows.map((row, i) => (
                            <span key={row.label + i}>
                              {i > 0 && ' · '}
                              <span className={row.unpaid ? 'text-amber-700 dark:text-amber-400' : undefined}>
                                {row.label} {formatDays(row.days)}
                              </span>
                            </span>
                          ))}
                        </span>
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
                  {field(
                    t('details.status'),
                    <>
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badgeCls(selected.statusKey)}`}
                        >
                          {selected.statusLabel}
                        </span>
                        {selected.cancelPendingLabel && (
                          <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                            {selected.cancelPendingLabel}
                          </span>
                        )}
                      </span>
                      {selected.stageLabel && (
                        <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                          {selected.stageLabel}
                          {/* Who it is waiting on (feedback 567333b7). Rendered only when the step resolved
                              to ONE named person — a direct manager. The role-based steps show the stage
                              wording alone, because they resolve to a set of people and naming one would
                              be untrue while listing them all would publish the HR roster.
                              `title` carries the full name on hover, as the item asks; initials are the
                              fallback so a colleague with no photo renders a circle rather than a broken
                              image. */}
                          {selected.approverName && (
                            <span
                              title={selected.approverName}
                              className="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px] font-medium text-foreground"
                            >
                              {selected.approverPersonId ? (
                                // eslint-disable-next-line @next/next/no-img-element -- same raw <img> the
                                // rest of the app uses for this route; it streams bytes, not a static asset.
                                <img
                                  src={`/personnel/photo/${selected.approverPersonId}`}
                                  alt={selected.approverName}
                                  className="size-full object-cover"
                                />
                              ) : (
                                selected.approverName.slice(0, 1).toUpperCase()
                              )}
                            </span>
                          )}
                        </span>
                      )}
                    </>,
                  )}
                  {selected.documentHref &&
                    field(
                      t('details.attachment'),
                      <a
                        href={selected.documentHref}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {selected.documentLabel}
                      </a>,
                    )}
                </dl>

                {/* Per-date outcome breakdown for a partially-approved record (R17 600be8ac ask #6). */}
                {selected.dateOutcome && <div className="px-5 pb-4">{selected.dateOutcome}</div>}

                {/* Actions live HERE, not on the card: Edit + Cancel Leave (pending) or Cancel dates
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
